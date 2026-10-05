#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { DefaultAddons, maybeDownloadAddons } from "./addons.js";
import { effectivePin, loadPin, pinMatches, pinSpec } from "./browser-pin.js";
import { CamoufoxNotInstalled, UnsupportedVersion } from "./exceptions.js";
import { ALLOW_GEOIP, downloadMMDB, removeMMDB } from "./locale.js";
import {
	type CachedVersion,
	channelPath,
	findInstalled,
	getActivePath,
	isSupported,
	latestInChannel,
	latestPerBuild,
	listInstalled,
	loadCachedVersions,
	loadConfig,
	parseSpecifier,
	removeVersion,
	resolveSpec,
	saveCachedVersions,
	saveConfig,
	selectBuild,
} from "./multiversion.js";
import {
	CamoufoxFetcher,
	camoufoxPath,
	INSTALL_DIR,
	installedVerStr,
	listAvailableVersions,
	SUPPORTED_RANGE,
	Version,
} from "./pkgman.js";
import { launchServer } from "./server.js";
import { Camoufox } from "./sync_api.js";
import { getAsBooleanFromENV } from "./utils.js";

class CamoufoxUpdate extends CamoufoxFetcher {
	currentVerStr: string | null;

	private constructor(selected?: CachedVersion) {
		super(selected);
		this.currentVerStr = null;
		try {
			this.currentVerStr = installedVerStr();
		} catch (error) {
			if (error instanceof Error && error.name === "FileNotFoundError") {
				this.currentVerStr = null;
			} else {
				throw error;
			}
		}
	}

	static async create(selected?: CachedVersion): Promise<CamoufoxUpdate> {
		const updater = new CamoufoxUpdate(selected);
		await updater.init();
		return updater;
	}

	isUpdateNeeded(): boolean {
		if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
			console.log(
				"Skipping browser download / update check due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set!",
			);
			return false;
		}

		return this.currentVerStr === null || this.currentVerStr !== this.verstr;
	}

	async update(): Promise<void> {
		if (!this.isUpdateNeeded()) {
			if (this.currentVerStr === null) {
				console.log(
					`No cached Camoufox binary found at ${INSTALL_DIR}. Provision it before launching, or unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD to download.`,
				);
			} else if (
				getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)
			) {
				console.log(
					`Using cached Camoufox v${this.currentVerStr} (update check skipped).`,
				);
			} else {
				console.log("Camoufox binaries up to date!");
				console.log(`Current version: v${this.currentVerStr}`);
			}
			return;
		}

		if (this.currentVerStr !== null) {
			console.log(
				`Updating Camoufox binaries from v${this.currentVerStr} => v${this.verstr}`,
			);
		} else {
			console.log(`Fetching Camoufox binaries...`);
		}
		await this.install();
	}

	async cleanup(): Promise<boolean> {
		if (!existsSync(INSTALL_DIR)) {
			return false;
		}
		await rmSync(INSTALL_DIR, { recursive: true, force: true });
		console.log("Camoufox binaries removed!");
		return true;
	}
}

async function sync(): Promise<CachedVersion[]> {
	console.log("Syncing available Camoufox builds...");
	const versions = await listAvailableVersions();
	saveCachedVersions(versions);
	console.log(
		`Synced ${versions.length} builds, ${versions.filter(isSupported).length} of them supported by this release.`,
	);
	return versions;
}

function printActive(): void {
	const config = loadConfig();
	const pin = effectivePin(config);
	const installed = listInstalled();
	let selection: string;
	let target: (typeof installed)[number] | undefined;
	if (pin) {
		target = installed.find((v) =>
			pinMatches(pin, v.repoName, v.version.version ?? "", v.version.release),
		);
		selection = `${target ? channelPath(target) : `${pin.repoName}/${pinSpec(pin)}`} (tested with this release)`;
	} else if (config.pinned) {
		target = installed.find(
			(v) =>
				v.version.fullString === config.pinned &&
				(!config.pinned_sha || v.sha256 === config.pinned_sha),
		);
		selection = `${config.channel}/${config.pinned}`;
	} else {
		const launchDir = getActivePath();
		target = installed.find((v) => v.path === launchDir);
		selection = target
			? channelPath(target)
			: (config.channel ?? "official/stable");
	}
	if (target) {
		console.log(selection);
		return;
	}
	try {
		// A flat install of an older release.
		console.log(
			`${selection} (not fetched), launching v${installedVerStr()} from ${camoufoxPath()}`,
		);
	} catch {
		console.log(`${selection} (not fetched)`);
	}
}

const program = new Command();

program
	.command("fetch")
	.description(
		"Install the build this release is tested with, the one chosen with `set`, or the given one",
	)
	.argument(
		"[version]",
		"A build (152.0.4-beta.30, official/stable/152.0.4-beta.30) or a channel (official/stable)",
	)
	.action(async (version?: string) => {
		let selected: CachedVersion | undefined;
		if (!getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
			selected = selectBuild(await sync(), version);
		}
		const updater = await CamoufoxUpdate.create(selected);
		await updater.update();
		if (ALLOW_GEOIP) {
			await downloadMMDB();
		}
		let launchVersion: string | undefined;
		try {
			launchVersion = Version.fromPath(camoufoxPath()).fullString;
		} catch (e) {
			if (
				!(e instanceof CamoufoxNotInstalled || e instanceof UnsupportedVersion)
			) {
				throw e;
			}
		}
		// `fetch <version>` doesn't change which build launches use.
		if (version && selected && launchVersion !== updater.verstr) {
			console.log(
				`Launches don't use v${updater.verstr}, run \`camoufox set ${updater.verstr}\` to switch to it.`,
			);
		}
		if (launchVersion) {
			await maybeDownloadAddons(DefaultAddons);
		}
	});

program
	.command("remove")
	.description("Remove all downloaded data, or only the given installed build")
	.argument(
		"[version]",
		"An installed build, e.g. official/stable/152.0.4-beta.30",
	)
	.action(async (version?: string) => {
		if (version) {
			const target = findInstalled(version);
			if (!target) {
				throw new Error(`Version '${version}' is not installed.`);
			}
			removeVersion(target);
			console.log(`Removed ${channelPath(target)}.`);
			return;
		}
		if (existsSync(INSTALL_DIR)) {
			rmSync(INSTALL_DIR, { recursive: true, force: true });
			console.log("Camoufox binaries removed!");
		} else {
			console.log("Camoufox binaries not found!");
		}
		removeMMDB();
	});

program
	.command("sync")
	.description("Refresh the list of available builds")
	.action(async () => {
		await sync();
	});

program
	.command("set")
	.description(
		"Choose the build to fetch and launch instead of the one this release is tested with",
	)
	.argument(
		"[specifier]",
		"A channel (official/stable, official/prerelease) or a build (152.0.4-beta.30, official/stable/152.0.4-beta.30)",
	)
	.option("--release", "Go back to the build this release is tested with")
	.action((specifier: string | undefined, options: { release?: boolean }) => {
		const { channel, pinned, pinned_sha, active_version, ...config } =
			loadConfig();
		if (options.release) {
			saveConfig(config);
			const pin = loadPin();
			console.log(
				`Using the build this release is tested with${pin ? `, v${pinSpec(pin)}` : ""}. Run \`camoufox fetch\` if it isn't installed.`,
			);
			return;
		}
		if (!specifier) {
			printActive();
			return;
		}

		const parsed = parseSpecifier(specifier);
		const versions = loadCachedVersions();
		if (!parsed.spec) {
			const latest =
				versions && latestInChannel(versions, parsed.channel ?? "stable");
			const installed =
				latest &&
				listInstalled().find(
					(v) => v.version.fullString === `${latest.version}-${latest.build}`,
				);
			saveConfig({
				...config,
				channel: `official/${parsed.channel}`,
				...(installed && { active_version: installed.relativePath }),
			});
			console.log(`Channel: official/${parsed.channel}`);
			console.log(
				installed
					? `Using ${channelPath(installed)} (installed).`
					: "Run `camoufox fetch` to install its latest build.",
			);
			return;
		}

		if (!versions) {
			throw new Error(
				"No list of available builds yet, run `camoufox sync` first.",
			);
		}
		const resolved = resolveSpec(versions, parsed.spec);
		if (!resolved) {
			throw new Error(
				`Version '${parsed.spec}' was not found, run \`camoufox sync\` to refresh the list.`,
			);
		}
		const { entry, sha256 } = resolved;
		if (!isSupported(entry)) {
			throw new UnsupportedVersion(
				`Camoufox v${entry.version}-${entry.build} is not supported by this release (supported range: ${SUPPORTED_RANGE}).`,
			);
		}
		const versionBuild = `${entry.version}-${entry.build}`;
		const ctype = entry.is_prerelease ? "prerelease" : "stable";
		const installed = listInstalled().find(
			(v) =>
				v.version.fullString === versionBuild &&
				(!sha256 || v.sha256 === sha256),
		);
		saveConfig({
			...config,
			channel: `official/${ctype}`,
			pinned: versionBuild,
			...(sha256 && { pinned_sha: sha256 }),
			...(installed && { active_version: installed.relativePath }),
		});
		console.log(
			`Pinned: official/${ctype}/${versionBuild}${installed ? " (installed)" : ""}`,
		);
		if (!installed) console.log("Run `camoufox fetch` to install it.");
	});

program
	.command("active")
	.description("Print the build launches use")
	.action(printActive);

program
	.command("list")
	.description("List installed builds, or all available ones")
	.argument("[mode]", "installed or all", "installed")
	.option("--path", "Show install paths")
	.action((mode: string, options: { path?: boolean }) => {
		const launchDir = getActivePath();
		const installed = listInstalled();
		if (mode === "all") {
			const versions = loadCachedVersions();
			if (!versions) {
				throw new Error(
					"No list of available builds yet, run `camoufox sync` first.",
				);
			}
			console.log("official/");
			for (const v of latestPerBuild(versions)) {
				const versionBuild = `${v.version}-${v.build}`;
				const inst = installed.find(
					(i) => i.version.fullString === versionBuild,
				);
				const tags = [
					v.is_prerelease ? "prerelease" : "stable",
					...(isSupported(v) ? [] : ["unsupported"]),
					...(inst
						? [inst.path === launchDir ? "installed, active" : "installed"]
						: []),
				];
				console.log(
					`    v${versionBuild} (${tags.join(") (")})${options.path && inst ? ` -> ${inst.path}` : ""}`,
				);
			}
			return;
		}
		if (installed.length === 0) {
			console.log("No versions installed. Run `camoufox fetch` to install.");
			return;
		}
		let repo: string | undefined;
		for (const v of installed) {
			if (v.repoName !== repo) {
				repo = v.repoName;
				console.log(`${repo}/`);
			}
			const tags = [
				v.isPrerelease ? "prerelease" : "stable",
				...(v.path === launchDir ? ["active"] : []),
			];
			console.log(
				`    v${v.version.fullString} (${tags.join(") (")})${options.path ? ` -> ${v.path}` : ""}`,
			);
		}
	});

program
	.command("test")
	.argument("[url]", "URL to open", null)
	.action(async (url) => {
		const browser = await Camoufox({
			headless: false,
			env: process.env as Record<string, string>,
			config: { showcursor: true },
			humanize: 0.5,
			geoip: true,
		});
		const page = await browser.newPage();
		if (url) {
			await page.goto(url);
		}
		await page.pause();
	});

program.command("server").action(async () => {
	const server = await launchServer({});

	console.log(`Camoufox server started at ${server.wsEndpoint()}`);
	console.log();
	console.log(
		`You can connect to it using Playwright's BrowserType.connect() method.`,
	);
	console.log(`To stop the server, press Ctrl+C or close this terminal.`);
});

program.command("path").action(() => {
	console.log(INSTALL_DIR);
});

program.command("version").action(async () => {
	const { version } = createRequire(import.meta.url)("../package.json");
	console.log(`camoufox-js:\tv${version}`);

	const updater = await CamoufoxUpdate.create();
	const binVer = updater.currentVerStr;

	if (!binVer) {
		console.log("Camoufox:\tNot downloaded!");
		return;
	}
	console.log(
		`Camoufox:\tv${binVer} ${updater.isUpdateNeeded() ? `(Latest supported: v${updater.verstr})` : "(Up to date!)"}`,
	);
});

program.parseAsync(process.argv).catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
