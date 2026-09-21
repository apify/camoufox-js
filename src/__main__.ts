#!/usr/bin/env node

/**
 * CLI package manager for Camoufox (port of the Python `camoufox` CLI).
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { Argument, Command, Option } from "commander";
import { DefaultAddons, maybeDownloadAddons } from "./addons.js";
import { CamoufoxNotInstalled, FileNotFoundError } from "./exceptions.js";
import { ALLOW_GEOIP, downloadMMDB, MMDB_FILE } from "./locale.js";
import {
	BROWSERS_DIR,
	type CachedRepo,
	type CachedVersion,
	type ChannelType,
	CONFIG_FILE,
	findInstall,
	findInstalled,
	getDefaultChannel,
	type InstalledVersion,
	installedLabel,
	isChannelType,
	latestInChannel,
	latestPerBuild,
	listInstalled,
	loadConfig,
	loadRepoCache,
	printTree,
	REPO_CACHE_FILE,
	removeVersion,
	repoData,
	resolveFetchTarget,
	resolveSpec,
	saveConfig,
	syncRepos,
	toAvailableVersion,
	versionBuild,
} from "./multiversion.js";
import {
	type AvailableVersion,
	CamoufoxFetcher,
	cleanOldData,
	formatAssetDate,
	INSTALL_DIR,
	installedVerStr,
	RepoConfig,
	rprint,
	sha8,
	style,
} from "./pkgman.js";
import { getAsBooleanFromENV, PACKAGE_ROOT } from "./platform.js";
import { launchServer } from "./server.js";
import { Camoufox } from "./sync_api.js";

// ---------------------------------------------------------------------------
// Prompt helpers (stand-ins for Python's click.confirm / inquirer)
// ---------------------------------------------------------------------------

function interactive(): boolean {
	return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

async function ask(question: string): Promise<string | null> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return (await rl.question(question)).trim();
	} catch {
		// Ctrl+C / closed stdin
		return null;
	} finally {
		rl.close();
	}
}

/**
 * Yes/no prompt. Outside a terminal there is nobody to ask, so the given
 * default decides.
 */
async function confirm(
	question: string,
	{ nonInteractiveDefault = false } = {},
): Promise<boolean> {
	if (!interactive()) return nonInteractiveDefault;
	const answer = await ask(`${question} [y/N]: `);
	return answer !== null && /^y(es)?$/i.test(answer);
}

/**
 * Numbered list selection. Returns the chosen value, or null when cancelled
 * or when there is no terminal to ask on.
 */
async function select<T>(
	choices: [label: string, value: T][],
	message: string,
): Promise<T | null> {
	if (!interactive()) {
		rprint(
			"Interactive selection needs a terminal. Pass a specifier instead.",
			"red",
		);
		return null;
	}
	console.log(style(`? ${message}`, "green", true));
	choices.forEach(([label], i) => {
		console.log(`  ${style(String(i + 1).padStart(2), "cyan")}) ${label}`);
	});
	const answer = await ask(`Select [1-${choices.length}]: `);
	if (answer === null || answer === "") return null;
	const idx = Number(answer) - 1;
	if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) {
		rprint(`Invalid selection '${answer}'.`, "red");
		return null;
	}
	return choices[idx][1];
}

function fail(msg: string): void {
	rprint(msg, "red");
	process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Checks & updates Camoufox
 */
class CamoufoxUpdate extends CamoufoxFetcher {
	currentVerStr: string | null;

	constructor(repoConfig?: RepoConfig, selectedVersion?: AvailableVersion) {
		super(repoConfig, selectedVersion);
		this.currentVerStr = null;
		try {
			this.currentVerStr = installedVerStr();
		} catch (error) {
			if (
				!(error instanceof CamoufoxNotInstalled) &&
				!(error instanceof FileNotFoundError)
			) {
				throw error;
			}
		}
	}

	isUpdateNeeded(): boolean {
		return this.currentVerStr === null || this.currentVerStr !== this.verstr;
	}

	async update({
		replace = false,
		iKnowWhatImDoing = false,
	}: {
		replace?: boolean;
		iKnowWhatImDoing?: boolean;
	} = {}): Promise<void> {
		if (!this.isUpdateNeeded() && !replace) {
			rprint("Camoufox binaries up to date!", "green");
			rprint(`Current version: v${this.currentVerStr}`, "green");
			return;
		}

		if (this.isPrerelease && !iKnowWhatImDoing) {
			rprint(`Warning: v${this.verstr} is a prerelease version!`, "yellow");
			if (
				!(await confirm("Continue with prerelease installation?", {
					// The user explicitly asked for a prerelease; don't stall CI on it.
					nonInteractiveDefault: true,
				}))
			) {
				rprint("Installation cancelled.", "red");
				return;
			}
		}

		const action = this.currentVerStr ? "Installing" : "Fetching";
		rprint(`${action} Camoufox v${this.verstr}...`, "yellow");
		await this.install({ replace });
	}
}

const program = new Command();

program
	.name("camoufox")
	.description("Camoufox package manager")
	.showHelpAfterError();

program
	.command("sync")
	.description("Sync available versions from remote repositories")
	.addOption(
		new Option("--spoof-os <os>", "Spoof OS (auto = native)").choices([
			"auto",
			"mac",
			"win",
			"lin",
		]),
	)
	.addOption(
		new Option(
			"--spoof-arch <arch>",
			"Spoof architecture (auto = native)",
		).choices(["auto", "x86_64", "i686", "arm64"]),
	)
	.action(async (opts: { spoofOs?: string; spoofArch?: string }) => {
		await syncRepos({
			spoofOs: opts.spoofOs === "auto" ? undefined : opts.spoofOs,
			spoofArch: opts.spoofArch === "auto" ? undefined : opts.spoofArch,
		});
	});

program
	.command("fetch")
	.description("Install the active version, or a specific version")
	.argument(
		"[version]",
		"version-build, repo/version-build, or repo/channel/version-build",
	)
	.option("--replace", "Reinstall even when this version is already installed")
	.addHelpText(
		"after",
		`
Examples:
  camoufox fetch                         # install active version
  camoufox fetch official/135.0-beta.25  # install specific version`,
	)
	.action(async (version: string | undefined, opts: { replace?: boolean }) => {
		if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
			console.log(
				"Skipping browser download / update check due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set!",
			);
			try {
				console.log(`Using cached Camoufox v${installedVerStr()}.`);
			} catch {
				console.log(
					`No cached Camoufox binary found at ${INSTALL_DIR}. Provision it before launching, or unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD to download.`,
				);
			}
			return;
		}

		// Clean up incompatible old data directory
		cleanOldData();

		const cache = await syncRepos();
		const target = resolveFetchTarget(cache, loadConfig(), version);
		if (!target.repoData || !target.verData) {
			fail(target.error ?? `Version '${target.display}' not found in cache.`);
			return;
		}

		const selected = toAvailableVersion(target.verData);
		const repoConfig = RepoConfig.findByName(target.repoData.name);
		try {
			await new CamoufoxUpdate(repoConfig, selected).update({
				replace: opts.replace,
			});
		} catch (e) {
			const msg = (e as Error).message ?? String(e);
			if (msg.includes("404") || msg.includes("Not Found")) {
				rprint("Release not found (404). Asset may have been removed.", "red");
				rprint("Run 'camoufox sync' to refresh available versions.", "yellow");
			} else {
				rprint(`Error: ${msg}`, "red");
			}
			process.exitCode = 1;
			return;
		}

		if (ALLOW_GEOIP) {
			await downloadMMDB();
		}
		await maybeDownloadAddons(DefaultAddons);
	});

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

/** Set to track a channel (fetches latest on fetch) */
function setChannel(repoName: string, channelType: ChannelType): void {
	const config = loadConfig();
	const lowerName = repoName.toLowerCase();
	config.channel = `${lowerName}/${channelType}`;
	delete config.pinned;
	delete config.pinned_sha;

	// Check if the latest for this channel is already installed
	const repo = repoData(loadRepoCache(), repoName);
	const latest = repo ? latestInChannel(repo, channelType) : undefined;
	if (latest) {
		const inst = listInstalled().find(
			(v) => v.version.build === latest.build && v.repoName === lowerName,
		);
		if (inst) {
			config.active_version = inst.relativePath;
			saveConfig(config);
			console.log(style(`Channel: ${lowerName}/${channelType}`, "cyan", true));
			console.log(
				style(`Using latest: ${inst.channelPath} (installed)`, "green"),
			);
			return;
		}
	}

	delete config.active_version;
	saveConfig(config);
	console.log(style(`Channel: ${lowerName}/${channelType}`, "cyan", true));
	console.log(style("Run 'camoufox fetch' to install latest.", "yellow"));
}

/** Pin a version-build, optionally to a specific dated asset by sha */
function setPinned(
	repoName: string,
	channelType: ChannelType,
	verData: CachedVersion,
	inst: InstalledVersion | undefined,
	sha?: string | null,
): void {
	const config = loadConfig();
	const lowerName = repoName.toLowerCase();
	config.channel = `${lowerName}/${channelType}`;
	config.pinned = versionBuild(verData);
	if (sha) {
		config.pinned_sha = sha;
	} else {
		delete config.pinned_sha;
	}
	const tag = sha ? ` (${sha.slice(0, 8)})` : "";
	const display = `${lowerName}/${channelType}/${versionBuild(verData)}${tag}`;
	if (inst) {
		config.active_version = inst.relativePath;
		saveConfig(config);
		console.log(style(`Pinned: ${display} (installed)`, "green"));
	} else {
		delete config.active_version;
		saveConfig(config);
		console.log(style(`Pinned: ${display}`, "cyan", true));
		console.log(style("Run 'camoufox fetch' to install.", "yellow"));
	}
}

function ensureSynced(): boolean {
	if (!existsSync(REPO_CACHE_FILE)) {
		fail("No repo cache found. Run 'camoufox sync' first.");
		return false;
	}
	return true;
}

function countBuilds(repo: CachedRepo, vb: string): number {
	return (repo.versions ?? []).filter((x) => versionBuild(x) === vb).length;
}

async function setInteractive(): Promise<void> {
	const cache = loadRepoCache();
	const installedList = listInstalled();

	if (!cache.repos?.length) {
		fail("No versions in cache. Run 'camoufox sync' first.");
		return;
	}

	const config = loadConfig();
	const channel = (config.channel || getDefaultChannel()).toLowerCase();
	const pinned = config.pinned;
	const pinnedSha = config.pinned_sha;

	if (pinned) {
		console.log(style(`Pinned: ${channel}/${pinned}`, "cyan"));
	} else {
		console.log(style(`Channel: ${channel}`, "cyan"));
	}
	console.log();

	// Full dated lists so the pin picker can show every date, not just the latest
	const channelVersions: [string, ChannelType, CachedVersion[]][] = [];
	for (const repo of cache.repos) {
		const versions = repo.versions ?? [];
		const stable = versions.filter((v) => !v.is_prerelease);
		const prereleases = versions.filter((v) => v.is_prerelease);
		if (stable.length) channelVersions.push([repo.name, "stable", stable]);
		if (prereleases.length) {
			channelVersions.push([repo.name, "prerelease", prereleases]);
		}
	}

	type Action =
		| "channel"
		| "exit"
		| { pin: [string, ChannelType, CachedVersion[]] };

	while (true) {
		const choices: [string, Action][] = [["Set channel", "channel"]];
		for (const entry of channelVersions) {
			const [name, ctype] = entry;
			choices.push([
				`Pin version: ${style(`${name.toLowerCase()}/${ctype}`, "cyan", true)}`,
				{ pin: entry },
			]);
		}
		choices.push([style("Exit", "bright_black"), "exit"]);

		const action = await select(choices, "Select");
		if (action === null || action === "exit") return;

		if (action === "channel") {
			const chChoices: [string, [string, ChannelType] | null][] = [];
			for (const [name, ctype, versions] of channelVersions) {
				const latest = latestPerBuild(versions)[0];
				const isCurrent = channel === `${name.toLowerCase()}/${ctype}`;
				let label = `${name.toLowerCase()}/${ctype} (latest: v${versionBuild(latest)})`;
				if (isCurrent) label = `${style(label, "green", true)} (current)`;
				chChoices.push([label, [name, ctype]]);
			}
			chChoices.push([style("Back", "bright_black"), null]);

			const picked = await select(chChoices, "Set channel");
			if (!picked) continue;
			setChannel(picked[0], picked[1]);
			return;
		}

		const [rname, ctype, versions] = action.pin;
		const vChoices: [string, CachedVersion | null][] = [];
		for (const v of versions) {
			const vb = versionBuild(v);
			const sha = v.sha256 ?? "";
			const date = formatAssetDate(v.created_at);
			const inst = findInstall(
				vb,
				v.sha256,
				installedList,
				countBuilds({ name: rname, repo: "", versions }, vb),
			);
			const isPinned = pinned === vb && (pinnedSha ?? null) === (sha || null);
			let label: string;
			let status: string;
			if (isPinned) {
				label = style(`v${vb}`, "green", true);
				status = "(pinned)";
			} else if (inst) {
				label = `v${vb}`;
				status = "(installed)";
			} else {
				label = style(`v${vb}`, "bright_black");
				status = "";
			}
			const cells = [date, sha ? `(${sha.slice(0, 8)})` : "", status].filter(
				Boolean,
			);
			vChoices.push([label + (cells.length ? `  ${cells.join("  ")}` : ""), v]);
		}
		vChoices.push([style("Back", "bright_black"), null]);

		const verData = await select(
			vChoices,
			`Pin version (${rname.toLowerCase()}/${ctype})`,
		);
		if (!verData) continue;

		const vb = versionBuild(verData);
		const inst = findInstall(
			vb,
			verData.sha256,
			installedList,
			countBuilds({ name: rname, repo: "", versions }, vb),
		);
		setPinned(rname, ctype, verData, inst, verData.sha256);
		return;
	}
}

program
	.command("set")
	.summary("Set the active Camoufox version to use & fetch")
	.description(
		`Set the active Camoufox version to use & fetch.
By default, this opens an interactive selector for versions and settings.
You can also pass a specifier to activate directly:
Pin version:
    camoufox set official/stable/134.0.2-beta.20
Automatically find latest in a channel source:
    camoufox set official/stable`,
	)
	.argument("[specifier]")
	.action(async (specifier: string | undefined) => {
		if (!specifier) {
			if (!ensureSynced()) return;
			await setInteractive();
			return;
		}

		const parts = specifier.toLowerCase().split("/");

		// 2-part sets a channel like official/stable
		if (parts.length === 2) {
			const [repoName, ctype] = parts;
			if (!isChannelType(ctype)) {
				fail(`Unknown channel type '${ctype}'. Use 'stable' or 'prerelease'.`);
				return;
			}
			setChannel(repoName, ctype);
			return;
		}

		// 1-part pins in the default repo, 3-part names the repo and channel
		let repoName: string;
		let spec: string;
		if (parts.length === 1) {
			repoName = RepoConfig.getDefaultName();
			spec = parts[0];
		} else if (parts.length === 3) {
			repoName = parts[0];
			spec = parts[2];
			if (!isChannelType(parts[1])) {
				fail(
					`Unknown channel type '${parts[1]}'. Use 'stable' or 'prerelease'.`,
				);
				return;
			}
		} else {
			fail(`Invalid specifier '${specifier}'.`);
			rprint(
				"Use: version-build, repo/channel, or repo/channel/version-build",
				"yellow",
			);
			return;
		}

		if (!ensureSynced()) return;
		const repo = repoData(loadRepoCache(), repoName);
		if (!repo) {
			fail(
				`Repo '${repoName.toLowerCase()}' not in cache. Run 'camoufox sync'.`,
			);
			return;
		}
		const { verData, sha } = resolveSpec(repo, spec.replace(/^v/, ""));
		if (!verData) {
			fail(`Version '${spec}' not found in ${repoName.toLowerCase()}.`);
			return;
		}
		const ctype: ChannelType = verData.is_prerelease ? "prerelease" : "stable";
		const vb = versionBuild(verData);
		const inst = findInstall(
			vb,
			verData.sha256,
			listInstalled(),
			countBuilds(repo, vb),
		);
		setPinned(repo.name, ctype, verData, inst, sha);
	});

// ---------------------------------------------------------------------------
// Active / list / remove
// ---------------------------------------------------------------------------

program
	.command("active")
	.description("Print the current active version")
	.action(() => {
		const config = loadConfig();
		const pinned = config.pinned;
		const channel = (config.channel || getDefaultChannel()).toLowerCase();
		const installed = listInstalled();

		const label = (v: InstalledVersion) => {
			const tag = sha8(v.sha256);
			return tag ? `${v.channelPath} (${tag})` : v.channelPath;
		};

		if (pinned) {
			const target = config.pinned_sha
				? installed.find((v) => v.sha256 === config.pinned_sha)
				: findInstalled(`${channel}/${pinned}`);
			if (target) {
				console.log(label(target));
			} else {
				console.log(
					`${channel}/${pinned} ${style("(not fetched)", "yellow", true)}`,
				);
			}
			return;
		}

		const active = installed.find((v) => v.isActive);
		if (active) {
			console.log(label(active));
		} else {
			console.log(`${channel} ${style("(not fetched)", "yellow", true)}`);
		}
	});

function listInstalledCmd(showPaths: boolean): void {
	printTree({ showPaths });

	console.log();
	const geoipPath = showPaths
		? style(` -> ${INSTALL_DIR}`, "bright_black")
		: "";
	console.log(`${style("geoip/", "cyan", true)}${geoipPath}`);
	if (existsSync(MMDB_FILE)) {
		console.log(
			`    └── ${path.basename(MMDB_FILE)} ${style("(MaxMind GeoLite2)", "green")}`,
		);
	} else {
		rprint("    └── Not downloaded", "yellow");
	}
}

function listAllCmd(): void {
	if (!ensureSynced()) return;

	const cache = loadRepoCache();
	const installed = new Map(listInstalled().map((v) => [v.version.build, v]));

	rprint("Available versions:\n", "yellow");

	for (const repo of cache.repos ?? []) {
		const versions = latestPerBuild(repo.versions ?? []);
		console.log(style(`${repo.name}/`, "cyan", true));

		versions.forEach((v, i) => {
			const inst = installed.get(v.build);
			const isActive = !!inst?.isActive;
			const prefix = i === versions.length - 1 ? "└── " : "├── ";
			let line = `    ${prefix}`;
			line += style(
				`v${versionBuild(v)}`,
				isActive ? "green" : undefined,
				isActive,
			);
			line += v.is_prerelease
				? style(" (prerelease)", "yellow")
				: style(" (stable)", "blue");
			if (inst) {
				line += isActive
					? style(" (installed, active)", "green", true)
					: style(" (installed)", "green");
			}
			console.log(line);
		});
		console.log();
	}
}

program
	.command("list")
	.summary("List Camoufox versions")
	.description(
		`List Camoufox versions

installed  Show installed versions (default)
all        Show all available versions from synced repos`,
	)
	.addArgument(
		new Argument("[mode]").choices(["installed", "all"]).default("installed"),
	)
	.option("--path", "Show full paths")
	.action((mode: "installed" | "all", opts: { path?: boolean }) => {
		if (mode === "all") {
			listAllCmd();
		} else {
			listInstalledCmd(!!opts.path);
		}
	});

program
	.command("remove")
	.summary("Remove downloaded data")
	.description(
		`Remove downloaded data. By default, this removes everything.
Pass --select to pick a browser version to remove.`,
	)
	.argument("[version_path]")
	.option("--select", "Interactively select a version to remove")
	.option("-y, --yes", "Skip confirmation prompts")
	.action(
		async (
			versionPath: string | undefined,
			opts: { select?: boolean; yes?: boolean },
		) => {
			const removeOne = async (target: InstalledVersion) => {
				if (opts.yes || (await confirm(`Remove ${target.channelPath}?`))) {
					removeVersion(target.path);
					rprint(`Removed ${target.channelPath}`, "green");
				} else if (!interactive()) {
					rprint("Pass -y to remove without confirmation.", "yellow");
				}
			};

			// Select mode: interactively pick a single version
			if (opts.select) {
				const installed = listInstalled();
				if (installed.length === 0) {
					rprint("No browser versions installed.", "yellow");
					return;
				}
				const choices: [string, InstalledVersion][] = installed.map((v) => {
					const tag = installedLabel(v);
					const suffix = tag ? ` (${tag})` : "";
					return [
						`${v.channelPath}${suffix}${v.isActive ? " [active]" : ""}`,
						v,
					];
				});
				const target = await select(choices, "Select version to remove");
				if (!target) {
					rprint("Cancelled.", "yellow");
					return;
				}
				await removeOne(target);
				return;
			}

			// Specific version: remove just that one
			if (versionPath) {
				const target = findInstalled(versionPath);
				if (!target) {
					fail(`Version '${versionPath}' not found.`);
					return;
				}
				await removeOne(target);
				return;
			}

			// Default: remove everything
			if (!existsSync(INSTALL_DIR) || readdirSync(INSTALL_DIR).length === 0) {
				rprint("Nothing to remove.", "yellow");
				return;
			}

			if (
				opts.yes ||
				(await confirm(`Remove the camoufox data directory (${INSTALL_DIR})?`))
			) {
				rmSync(INSTALL_DIR, { recursive: true, force: true });
				rprint("Removed camoufox data directory.", "green");
			} else if (!interactive()) {
				rprint("Pass -y to remove without confirmation.", "yellow");
			}
		},
	);

// ---------------------------------------------------------------------------
// Test / server / path / version
// ---------------------------------------------------------------------------

program
	.command("test")
	.description("Open the Playwright inspector")
	.argument("[url]", "URL to open")
	.option("--executable-path <path>", "Path to the Camoufox executable")
	.action(
		async (url: string | undefined, opts: { executablePath?: string }) => {
			const browser = await Camoufox({
				headless: false,
				env: process.env as Record<string, string>,
				config: { showcursor: true },
				humanize: 0.5,
				geoip: true,
				executable_path: opts.executablePath,
			});
			const page = await browser.newPage();
			if (url) {
				await page.goto(url);
			}
			await page.pause();
		},
	);

program
	.command("server")
	.description("Launch a Playwright server")
	.action(async () => {
		const server = await launchServer({});

		console.log(`Camoufox server started at ${server.wsEndpoint()}`);
		console.log();
		console.log(
			`You can connect to it using Playwright's BrowserType.connect() method.`,
		);
		console.log(`To stop the server, press Ctrl+C or close this terminal.`);
	});

program
	.command("path")
	.description("Print the install directory path")
	.action(() => {
		console.log(INSTALL_DIR);
	});

function packageVersion(name: string): string | undefined {
	try {
		if (name === "camoufox-js") {
			return JSON.parse(
				readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8"),
			).version;
		}
		const require = createRequire(import.meta.url);
		try {
			return require(`${name}/package.json`).version;
		} catch {
			// The package's "exports" map may hide package.json: walk up from its entry point.
			let dir = path.dirname(require.resolve(name));
			while (dir !== path.dirname(dir)) {
				const pkgJson = path.join(dir, "package.json");
				if (existsSync(pkgJson)) {
					const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
					if (pkg.name === name) return pkg.version;
				}
				dir = path.dirname(dir);
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
}

function dirSize(dir: string): string {
	if (!existsSync(dir)) return "Nothing here";
	let total = 0;
	const walk = (p: string) => {
		for (const entry of readdirSync(p, { withFileTypes: true })) {
			const full = path.join(p, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) total += statSync(full).size;
		}
	};
	walk(dir);
	for (const unit of ["B", "KB", "MB"]) {
		if (total < 1024) {
			return unit === "B" ? `${total} B` : `${total.toFixed(1)} ${unit}`;
		}
		total /= 1024;
	}
	return `${total.toFixed(1)} GB`;
}

function formatMtime(file: string): string {
	const d = statSync(file).mtime;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

program
	.command("version")
	.description("Display version, package, browser, and storage info")
	.action(() => {
		const rows: [string, string][] = [];
		const header = (title: string) =>
			rows.push([style(title, undefined, true), ""]);
		const row = (label: string, value: string) =>
			rows.push([style(`  ${label}`, "bright_black"), value]);
		const pkg = (label: string, name: string) => {
			const v = packageVersion(name);
			row(label, v ? style(`v${v}`, "green") : style("?", "bright_black"));
		};

		header("Node Packages");
		pkg("Camoufox", "camoufox-js");
		pkg("Fingerprint Generator", "fingerprint-generator");
		pkg("Playwright", "playwright-core");

		header("Browser");
		const config = loadConfig();
		const channel = (config.channel || getDefaultChannel()).toLowerCase();
		row(
			"Active",
			style(config.pinned ? `${channel}/${config.pinned}` : channel, "green"),
		);

		const activeV = listInstalled().find((v) => v.isActive);
		if (activeV) {
			row("Current browser", style(`v${activeV.version.fullString}`, "green"));
			if (activeV.createdAt) {
				row(
					"Build date",
					style(formatAssetDate(activeV.createdAt), "bright_black"),
				);
			}
			if (activeV.sha256) {
				row("SHA256", style(activeV.sha256.slice(0, 12), "bright_black"));
			}
			row("Installed", style("Yes", "green"));

			// Is the installed version the latest in its own channel?
			const ctype: ChannelType = activeV.isPrerelease ? "prerelease" : "stable";
			const repo = repoData(loadRepoCache(), activeV.repoName);
			const latest = repo ? latestInChannel(repo, ctype) : undefined;
			const isLatest = !!latest && latest.build === activeV.version.build;
			row(
				`Latest in ${activeV.repoName}/${ctype}?`,
				isLatest ? style("Yes", "green") : style("No", "red"),
			);
		} else {
			row("Current browser", style("Not installed", "bright_black"));
			row("Installed", style("No", "red"));
		}

		if (existsSync(REPO_CACHE_FILE)) {
			row("Last Sync", style(formatMtime(REPO_CACHE_FILE), "bright_black"));
		} else {
			row("Last Sync", style("Never", "red"));
		}

		header("GeoIP");
		if (existsSync(MMDB_FILE)) {
			row("Database", style("MaxMind GeoLite2", "green"));
			row("Updated", style(formatMtime(MMDB_FILE), "bright_black"));
		} else {
			row("Database", style("Not installed", "bright_black"));
		}

		header("Storage");
		row("Install path", style(INSTALL_DIR, "cyan"));
		row(
			"Browser(s) directory size",
			style(dirSize(BROWSERS_DIR), "bright_black"),
		);
		row("Config file", style(CONFIG_FILE, "cyan"));
		row("Repo cache", style(REPO_CACHE_FILE, "cyan"));

		// Pad labels on their visible width (strip ANSI codes)
		const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
		const visible = (s: string) => s.replace(ansi, "").length;
		const width = Math.max(...rows.map(([l]) => visible(l)));
		for (const [label, value] of rows) {
			console.log(`${label}${" ".repeat(width - visible(label) + 2)}${value}`);
		}
	});

program.parseAsync(process.argv).catch((e) => {
	fail(`Error: ${(e as Error).message ?? e}`);
});
