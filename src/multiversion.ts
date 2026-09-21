/**
 * Manager for handling multiple Camoufox versions side by side.
 *
 * Port of `multiversion.py` from the Python library. The on-disk layout and
 * file formats are identical, so an INSTALL_DIR can be shared between the
 * Python and JS libraries:
 *
 *   <INSTALL_DIR>/browsers/<repo>/<version>-<build>-<sha8>/  one install
 *   <INSTALL_DIR>/config.json        active version, channel and pin
 *   <INSTALL_DIR>/repo_cache.json    catalog of release assets (`camoufox sync`)
 *   <INSTALL_DIR>/.0.5_FLAG          marks the directory as using this layout
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AvailableVersion,
	availableVersionMetadata,
	type CamoufoxFetcher,
	formatAssetDate,
	listAvailableVersions,
	RepoConfig,
	rprint,
	sha8,
	style,
	Version,
	type VersionMetadata,
	verifySha256,
	webdl,
} from "./pkgman.js";
import { INSTALL_DIR, OS_NAME } from "./platform.js";

export const BROWSERS_DIR: string = path.join(INSTALL_DIR, "browsers");
export const CONFIG_FILE: string = path.join(INSTALL_DIR, "config.json");
export const REPO_CACHE_FILE: string = path.join(
	INSTALL_DIR,
	"repo_cache.json",
);
export const COMPAT_FLAG: string = path.join(INSTALL_DIR, ".0.5_FLAG");

export type ChannelType = "stable" | "prerelease";

export function isChannelType(s: string): s is ChannelType {
	return s === "stable" || s === "prerelease";
}

// ---------------------------------------------------------------------------
// User config
// ---------------------------------------------------------------------------

/** Contents of `config.json`. */
export interface Config {
	/** Path of the active install relative to INSTALL_DIR, e.g. `browsers/official/135.0-beta.25-8020db3b` */
	active_version?: string | null;
	/** Channel to follow, e.g. `official/stable` */
	channel?: string;
	/** Pinned `version-build`, e.g. `135.0-beta.25` */
	pinned?: string;
	/** Pin to a specific dated asset by its sha256 */
	pinned_sha?: string;
}

/** Load user config from disk, or return an empty object */
export function loadConfig(): Config {
	if (fs.existsSync(CONFIG_FILE)) {
		try {
			return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		} catch {
			// corrupt config: start over
		}
	}
	return {};
}

/**
 * Mark INSTALL_DIR as using the versioned layout, so it is never mistaken
 * for a legacy flat install and cleaned up.
 */
export function touchCompatFlag(): void {
	fs.mkdirSync(INSTALL_DIR, { recursive: true });
	fs.closeSync(fs.openSync(COMPAT_FLAG, "a"));
}

/** Save user config to disk */
export function saveConfig(config: Config): void {
	touchCompatFlag();
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** The default repo's stable channel string (like `official/stable`) */
export function getDefaultChannel(): string {
	return `${RepoConfig.getDefaultName().toLowerCase()}/stable`;
}

// ---------------------------------------------------------------------------
// Repo cache
// ---------------------------------------------------------------------------

/** One release asset as stored in `repo_cache.json`. */
export interface CachedVersion {
	version: string;
	build: string;
	url: string;
	is_prerelease: boolean;
	asset_id?: number | null;
	asset_size?: number | null;
	asset_updated_at?: string | null;
	sha256?: string | null;
	created_at?: string | null;
}

export interface CachedRepo {
	/** Display name from the repo definition, e.g. `Official` */
	name: string;
	/** Primary GitHub repo, e.g. `daijro/camoufox` */
	repo: string;
	versions: CachedVersion[];
}

export interface RepoCache {
	repos: CachedRepo[];
	spoof_os?: string | null;
	spoof_arch?: string | null;
}

/** Load cached repo data from disk */
export function loadRepoCache(): RepoCache {
	if (fs.existsSync(REPO_CACHE_FILE)) {
		try {
			return JSON.parse(fs.readFileSync(REPO_CACHE_FILE, "utf-8"));
		} catch {
			// corrupt cache: treat as empty
		}
	}
	return { repos: [] };
}

/** Save repo cache to disk */
export function saveRepoCache(cache: RepoCache): void {
	touchCompatFlag();
	fs.writeFileSync(REPO_CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function toCachedVersion(v: AvailableVersion): CachedVersion {
	return {
		version: v.version.version ?? "",
		build: v.version.build,
		url: v.url,
		is_prerelease: v.isPrerelease,
		asset_id: v.assetId ?? null,
		asset_size: v.assetSize ?? null,
		asset_updated_at: v.assetUpdatedAt ?? null,
		sha256: v.sha256 ?? null,
		created_at: v.assetCreatedAt ?? null,
	};
}

export function toAvailableVersion(v: CachedVersion): AvailableVersion {
	return {
		version: new Version(v.build, v.version),
		url: v.url,
		isPrerelease: v.is_prerelease ?? false,
		assetId: v.asset_id ?? null,
		assetSize: v.asset_size ?? null,
		assetUpdatedAt: v.asset_updated_at ?? null,
		sha256: v.sha256 ?? null,
		assetCreatedAt: v.created_at ?? null,
	};
}

/** Cached available versions, optionally filtered by repo, newest first */
export function getCachedVersions(repoName?: string): AvailableVersion[] {
	const cache = loadRepoCache();
	const versions: AvailableVersion[] = [];
	for (const repo of cache.repos ?? []) {
		if (repoName && repo.name.toLowerCase() !== repoName.toLowerCase()) {
			continue;
		}
		for (const v of repo.versions ?? []) {
			versions.push(toAvailableVersion(v));
		}
	}
	versions.sort((a, b) => b.version.compare(a.version));
	return versions;
}

/** `version-build` key of a cache entry */
export function versionBuild(v: CachedVersion): string {
	return `${v.version}-${v.build}`;
}

function compareCached(a: CachedVersion, b: CachedVersion): number {
	return (
		new Version(a.build, a.version).compare(new Version(b.build, b.version)) ||
		(a.created_at ?? "").localeCompare(b.created_at ?? "")
	);
}

/**
 * Keep one cache entry per `version-build`, the newest by `created_at`.
 * Sorted newest first.
 */
export function latestPerBuild(versions: CachedVersion[]): CachedVersion[] {
	const best = new Map<string, CachedVersion>();
	for (const v of versions) {
		const key = versionBuild(v);
		const cur = best.get(key);
		if (!cur || (v.created_at ?? "") > (cur.created_at ?? "")) {
			best.set(key, v);
		}
	}
	return [...best.values()].sort((a, b) => compareCached(b, a));
}

/** Cache block for a repo by (case-insensitive) name */
export function repoData(
	cache: RepoCache,
	repoName: string,
): CachedRepo | undefined {
	const lower = repoName.toLowerCase();
	return (cache.repos ?? []).find((r) => r.name.toLowerCase() === lower);
}

/** Newest cache entry in a channel of a repo */
export function latestInChannel(
	repo: CachedRepo,
	channelType: ChannelType,
): CachedVersion | undefined {
	const isPre = channelType === "prerelease";
	return latestPerBuild(repo.versions ?? []).find(
		(v) => (v.is_prerelease ?? false) === isPre,
	);
}

/** Display name for a GitHub repo (`owner/name`), lowercased */
export function getRepoName(githubRepo: string): string {
	for (const repo of RepoConfig.loadRepos()) {
		if (repo.repos.includes(githubRepo)) {
			return repo.name.toLowerCase();
		}
	}
	return githubRepo.split("/")[0].toLowerCase();
}

/**
 * Sync available versions from the remote repositories into `repo_cache.json`.
 * A repo that fails to sync keeps its previously cached versions.
 */
export async function syncRepos({
	spoofOs,
	spoofArch,
	quiet = false,
}: {
	spoofOs?: string;
	spoofArch?: string;
	quiet?: boolean;
} = {}): Promise<RepoCache> {
	if (!quiet) rprint("Syncing repositories...", "yellow");

	const previous = loadRepoCache();
	const cache: RepoCache = {
		repos: [],
		spoof_os: spoofOs ?? null,
		spoof_arch: spoofArch ?? null,
	};

	for (const repoConfig of RepoConfig.loadRepos()) {
		if (!quiet) rprint(`  ${repoConfig.name}...`, "cyan", false);
		try {
			const versions = await listAvailableVersions({
				repoConfig,
				includePrerelease: true,
				spoofOs,
				spoofArch,
			});
			cache.repos.push({
				name: repoConfig.name,
				repo: repoConfig.repo,
				versions: versions.map(toCachedVersion),
			});
			if (!quiet) rprint(` ${versions.length} versions`, "green");
		} catch (e) {
			if (!quiet) rprint(` Error: ${(e as Error).message ?? e}`, "red");
			const stale = repoData(previous, repoConfig.name);
			if (stale) cache.repos.push(stale);
		}
	}

	saveRepoCache(cache);
	if (!quiet) {
		const total = cache.repos.reduce((n, r) => n + r.versions.length, 0);
		const platform = spoofOs ? ` (${spoofOs}/${spoofArch ?? "auto"})` : "";
		rprint(
			`\nSynced ${total} versions from ${cache.repos.length} repos${platform}.`,
			"green",
		);
	}
	return cache;
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `version-build` or `version-build-sha8` spec against cache
 * entries. Returns the asset and its sha for a specific dated asset, the
 * latest asset of the build and no sha to follow the latest, or nothing when
 * the spec is unknown.
 */
export function resolveSpec(
	repo: CachedRepo,
	spec: string,
): { verData?: CachedVersion; sha?: string } {
	const versions = repo.versions ?? [];
	for (const v of versions) {
		const sha = v.sha256 ?? "";
		if (sha && spec === `${versionBuild(v)}-${sha.slice(0, 8)}`) {
			return { verData: v, sha };
		}
	}
	for (const v of latestPerBuild(versions)) {
		if (spec === versionBuild(v)) {
			return { verData: v };
		}
	}
	return {};
}

/** Cache entry a pin resolves to: the specific sha asset or the latest of the build */
export function pinTarget(
	repo: CachedRepo,
	pinned: string,
	pinnedSha?: string | null,
): CachedVersion | undefined {
	const versions = repo.versions ?? [];
	if (pinnedSha) {
		return versions.find((v) => v.sha256 === pinnedSha);
	}
	return latestPerBuild(versions).find((v) => versionBuild(v) === pinned);
}

export interface ResolvedTarget {
	/** Lowercased repo name the target lives in */
	repoName: string;
	/** Human readable description of what was asked for */
	display: string;
	repoData?: CachedRepo;
	verData?: CachedVersion;
	/** Set when the specifier is malformed or nothing matched */
	error?: string;
}

/**
 * Work out which cache entry `camoufox fetch [specifier]` should install.
 *
 * Without a specifier the config decides: the pinned version, or the latest
 * in the followed channel (`official/stable` by default). A specifier is
 * `version-build`, `repo/version-build` or `repo/channel/version-build`.
 */
export function resolveFetchTarget(
	cache: RepoCache,
	config: Config,
	specifier?: string | null,
): ResolvedTarget {
	if (specifier) {
		const parts = specifier.toLowerCase().split("/");
		let repoName: string;
		let spec: string;
		if (parts.length === 1) {
			repoName = RepoConfig.getDefaultName().toLowerCase();
			spec = parts[0];
		} else if (parts.length === 2 || parts.length === 3) {
			repoName = parts[0];
			spec = parts[parts.length - 1];
		} else {
			return {
				repoName: "",
				display: specifier,
				error:
					"Format: version-build, repo/version-build, or repo/channel/version-build",
			};
		}
		const repo = repoData(cache, repoName);
		const { verData } = repo
			? resolveSpec(repo, spec.replace(/^v/, ""))
			: { verData: undefined };
		return {
			repoName,
			display: specifier,
			repoData: repo,
			verData,
			error: verData
				? undefined
				: `Version '${specifier}' not found in cache. Run 'camoufox sync'.`,
		};
	}

	return resolveActiveTarget(cache, config);
}

/**
 * The cache entry the current config points at (pin, or latest in channel).
 */
export function resolveActiveTarget(
	cache: RepoCache,
	config: Config,
): ResolvedTarget {
	const channel = (config.channel || getDefaultChannel()).toLowerCase();
	const [repoName, ctype = "stable"] = channel.split("/", 2);
	const repo = repoData(cache, repoName);

	if (config.pinned) {
		const display = `${channel}/${config.pinned}`;
		const verData = repo
			? pinTarget(repo, config.pinned, config.pinned_sha)
			: undefined;
		return {
			repoName,
			display,
			repoData: repo,
			verData,
			error: verData
				? undefined
				: `Version '${display}' not found in cache. Run 'camoufox sync'.`,
		};
	}

	const channelType: ChannelType = isChannelType(ctype) ? ctype : "stable";
	const verData = repo ? latestInChannel(repo, channelType) : undefined;
	return {
		repoName,
		display: channel,
		repoData: repo,
		verData,
		error: verData
			? undefined
			: `No release found for '${channel}' in cache. Run 'camoufox sync'.`,
	};
}

// ---------------------------------------------------------------------------
// Installed versions
// ---------------------------------------------------------------------------

/**
 * Information about an installed Camoufox version.
 */
export class InstalledVersion {
	constructor(
		public repoName: string,
		public version: Version,
		public path: string,
		public isActive = false,
		public isPrerelease = false,
		public assetId: number | null = null,
		public assetSize: number | null = null,
		public assetUpdatedAt: string | null = null,
		public sha256: string | null = null,
		public createdAt: string | null = null,
	) {}

	/** Path relative to INSTALL_DIR like `browsers/official/135.0-beta.25-8020db3b` */
	get relativePath(): string {
		return `browsers/${this.repoName}/${path.basename(this.path)}`;
	}

	/** Channel display string (like `official/stable/134.0.2-beta.20`) */
	get channelPath(): string {
		const ctype = this.isPrerelease ? "prerelease" : "stable";
		return `${this.repoName}/${ctype}/${this.version.fullString}`;
	}

	/** Compare with an available version and return change indicators */
	getChanges(available: AvailableVersion): string[] {
		const changes: string[] = [];
		if (this.isPrerelease && !available.isPrerelease) {
			changes.push("prerelease -> stable");
		} else if (!this.isPrerelease && available.isPrerelease) {
			changes.push("stable -> prerelease");
		}

		if (this.assetUpdatedAt && available.assetUpdatedAt) {
			if (this.assetUpdatedAt !== available.assetUpdatedAt) {
				changes.push("asset updated");
			}
		} else if (this.assetSize && available.assetSize) {
			if (this.assetSize !== available.assetSize) {
				changes.push("asset updated");
			}
		}
		return changes;
	}
}

/** Install folder name with an optional sha8 suffix */
export function versionFolderName(
	version: string,
	build: string,
	sha8Suffix = "",
): string {
	const base = `${version}-${build}`;
	return sha8Suffix ? `${base}-${sha8Suffix}` : base;
}

/**
 * Get the installed folder for a catalog item. Falls back to `version-build/`
 * (without the sha8) for backwards compatibility.
 */
function matchInstall(
	full: string,
	sha256: string | null | undefined,
	byFolder: Map<string, InstalledVersion>,
	count: number,
): InstalledVersion | undefined {
	const suffix = sha8(sha256);
	if (suffix) {
		const exact = byFolder.get(`${full}-${suffix}`);
		if (exact) return exact;
	}
	const legacy = byFolder.get(full);
	if (!legacy) return undefined;
	if (legacy.sha256) {
		return legacy.sha256 === sha256 ? legacy : undefined;
	}
	return count <= 1 ? legacy : undefined;
}

/**
 * Match each catalog item to an install folder. Returns the matches (one per
 * catalog item, possibly undefined) and any orphaned leftovers with a note.
 */
export function classifyInstalls(
	versions: AvailableVersion[],
	installed: InstalledVersion[],
): [
	(InstalledVersion | undefined)[],
	[InstalledVersion, "date unknown" | "unavailable"][],
] {
	const counts = new Map<string, number>();
	for (const v of versions) {
		const key = v.version.fullString;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const byFolder = new Map(installed.map((iv) => [path.basename(iv.path), iv]));

	const matched = new Set<string>();
	const rows = versions.map((v) => {
		const full = v.version.fullString;
		const inst = matchInstall(full, v.sha256, byFolder, counts.get(full) ?? 0);
		if (inst) matched.add(path.basename(inst.path));
		return inst;
	});

	const extras: [InstalledVersion, "date unknown" | "unavailable"][] = [];
	for (const iv of installed) {
		if (matched.has(path.basename(iv.path))) continue;
		const inCatalog = (counts.get(iv.version.fullString) ?? 0) > 0;
		extras.push([iv, inCatalog && !iv.sha256 ? "date unknown" : "unavailable"]);
	}
	return [rows, extras];
}

/** Installed version for a single `version-build` and sha, legacy folder allowed */
export function findInstall(
	versionBuildStr: string,
	sha256: string | null | undefined,
	installed: InstalledVersion[],
	count = 1,
): InstalledVersion | undefined {
	return matchInstall(
		versionBuildStr,
		sha256,
		new Map(installed.map((iv) => [path.basename(iv.path), iv])),
		count,
	);
}

/** Find an installed version by its build string */
export function findInstalledByBuild(
	build: string,
	repoName?: string,
): InstalledVersion | undefined {
	return listInstalled().find(
		(v) =>
			v.version.build === build &&
			(repoName === undefined || v.repoName === repoName),
	);
}

/**
 * Scan `browsers/` for installed versions, sorted by repo then version
 * descending.
 */
export function listInstalled(): InstalledVersion[] {
	const installed: InstalledVersion[] = [];
	if (!fs.existsSync(BROWSERS_DIR)) return installed;

	const active = loadConfig().active_version;

	for (const repoDir of fs.readdirSync(BROWSERS_DIR, { withFileTypes: true })) {
		if (!repoDir.isDirectory() || repoDir.name.startsWith(".")) continue;
		const repoPath = path.join(BROWSERS_DIR, repoDir.name);

		for (const versionDir of fs.readdirSync(repoPath, {
			withFileTypes: true,
		})) {
			if (!versionDir.isDirectory()) continue;
			const versionPath = path.join(repoPath, versionDir.name);
			const versionJson = path.join(versionPath, "version.json");
			if (!fs.existsSync(versionJson)) continue;

			try {
				const ver = Version.fromPath(versionPath);
				const data: VersionMetadata = JSON.parse(
					fs.readFileSync(versionJson, "utf-8"),
				);
				const relPath = `browsers/${repoDir.name}/${versionDir.name}`;
				installed.push(
					new InstalledVersion(
						repoDir.name,
						ver,
						versionPath,
						relPath === active,
						data.prerelease ?? false,
						data.asset_id ?? null,
						data.asset_size ?? null,
						data.asset_updated_at ?? null,
						data.sha256 ?? null,
						data.created_at ?? null,
					),
				);
			} catch {
				// unreadable version.json: skip this folder
			}
		}
	}

	installed.sort(
		(a, b) =>
			b.repoName.localeCompare(a.repoName) || b.version.compare(a.version),
	);
	return installed;
}

/**
 * Path to the active version, or null if no version is active. When the user
 * has neither a channel nor a pin configured, the newest install is activated.
 */
export function getActivePath(): string | null {
	const config = loadConfig();
	const active = config.active_version;

	if (active) {
		const p = path.join(INSTALL_DIR, active);
		if (fs.existsSync(path.join(p, "version.json"))) {
			return p;
		}
	}

	// Only auto-select if the user didn't set a channel or pin
	if (!config.channel && !config.pinned) {
		const installed = listInstalled();
		if (installed.length > 0) {
			config.active_version = installed[0].relativePath;
			saveConfig(config);
			return installed[0].path;
		}
	}

	return null;
}

/** Set the active version by its relative path */
export function setActive(relativePath: string): void {
	const config = loadConfig();
	config.active_version = relativePath;
	saveConfig(config);
}

/**
 * Find an installed version by channel path, relative path, build, full
 * version string, `repo/version-build`, or `repo/channel` (newest installed
 * in that channel).
 */
export function findInstalled(specifier: string): InstalledVersion | undefined {
	const spec = specifier.toLowerCase();
	const installed = listInstalled();
	const parts = spec.split("/");

	for (const v of installed) {
		if (
			v.channelPath.toLowerCase() === spec ||
			v.relativePath.toLowerCase() === spec ||
			v.version.build.toLowerCase() === spec ||
			v.version.fullString.toLowerCase() === spec
		) {
			return v;
		}
		// Match repo/version without channel, e.g. official/134.0.2-beta.20
		if (parts.length === 2) {
			const [repo, ver] = parts;
			if (v.repoName === repo && v.version.fullString.toLowerCase() === ver) {
				return v;
			}
		}
	}

	// Match repo/channel, e.g. official/stable gets the latest installed for that channel
	if (parts.length === 2) {
		const [repo, ctype] = parts;
		if (isChannelType(ctype)) {
			const isPre = ctype === "prerelease";
			return installed.find(
				(v) => v.repoName === repo && v.isPrerelease === isPre,
			);
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/** Remove staging dirs left behind by an interrupted install. */
function removeLeftovers(installPath: string): void {
	const parent = path.dirname(installPath);
	if (!fs.existsSync(parent)) return;
	const prefix = `${path.basename(installPath)}.staging-`;
	for (const name of fs.readdirSync(parent)) {
		if (name.startsWith(prefix)) {
			fs.rmSync(path.join(parent, name), { recursive: true, force: true });
		}
	}
}

/**
 * Install to `browsers/{repo}/{version}-{build}-{sha8}` (suffix omitted when
 * no sha is known) and make it the active version.
 *
 * The archive is downloaded to a temp file, verified against its published
 * sha256 and extracted into a staging directory next to the target; only a
 * complete install is moved into place, so an interrupted download never
 * leaves a half-written browser behind.
 *
 * Returns false when the version was already installed and `replace` is not
 * set, true after a fresh install.
 */
export async function installVersioned(
	fetcher: CamoufoxFetcher,
	{ replace = false }: { replace?: boolean } = {},
): Promise<boolean> {
	const repoName = getRepoName(fetcher.githubRepo);
	const suffix = fetcher._selected_version?.sha256
		? sha8(fetcher._selected_version.sha256)
		: fetcher.installedSha8;
	const folder = versionFolderName(fetcher.version, fetcher.build, suffix);
	const relativePath = `browsers/${repoName}/${folder}`;
	const installPath = path.join(BROWSERS_DIR, repoName, folder);

	const alreadyInstalled = fs.existsSync(
		path.join(installPath, "version.json"),
	);
	if (alreadyInstalled && !replace) {
		let changeMsg = "";
		const installedV = findInstalledByBuild(fetcher.build, repoName);
		if (installedV && fetcher._selected_version) {
			const changes = installedV.getChanges(fetcher._selected_version);
			if (changes.length) changeMsg = ` (${changes.join(", ")})`;
		}
		rprint(
			`Version v${fetcher.verstr} already installed${changeMsg}.`,
			"yellow",
		);
		rprint(
			changeMsg
				? "Use --replace to update with the new release."
				: "Use --replace to reinstall.",
			"yellow",
		);
		// Activate it when nothing (usable) is active, e.g. the previously active
		// folder was removed by hand.
		const active = loadConfig().active_version;
		if (
			!active ||
			!fs.existsSync(path.join(INSTALL_DIR, active, "version.json"))
		) {
			setActive(relativePath);
		}
		return false;
	}

	fs.mkdirSync(path.dirname(installPath), { recursive: true });
	removeLeftovers(installPath);
	// Staged next to the install dir so the final rename stays on one filesystem.
	// Set up outside the try so finally can always tear down the ~600MB staging dirs.
	const stagingDir = fs.mkdtempSync(`${installPath}.staging-`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-"));
	const tempFilePath = path.join(tempDir, "camoufox.zip");
	const tempFileStream = fs.createWriteStream(tempFilePath);
	try {
		rprint(`Downloading package: ${fetcher.url}`);
		await webdl(fetcher.url, "Downloading Camoufox...", true, tempFileStream);
		await new Promise<void>((resolve, reject) =>
			tempFileStream.close((err) => (err ? reject(err) : resolve())),
		);

		const expectedSha =
			fetcher._selected_version?.sha256 ?? fetcher.installedSha256;
		await verifySha256(
			tempFilePath,
			expectedSha,
			`Camoufox v${fetcher.verstr}`,
		);

		rprint(`Extracting Camoufox: ${installPath}`);
		await fetcher.extractZip(tempFilePath, stagingDir);

		const metadata = fetcher._selected_version
			? availableVersionMetadata(fetcher._selected_version)
			: fetcher.metadata;
		fs.writeFileSync(
			path.join(stagingDir, "version.json"),
			JSON.stringify(metadata),
		);

		if (OS_NAME !== "win") {
			execFileSync("chmod", ["-R", "755", stagingDir]);
		}

		// Replace the previous copy only once the new one is complete.
		if (alreadyInstalled) {
			rprint(`Replacing: ${installPath}`, "yellow");
		}
		fs.rmSync(installPath, { recursive: true, force: true });
		fs.renameSync(stagingDir, installPath);

		// Also marks the install dir as using the versioned layout
		setActive(relativePath);

		rprint(`\nCamoufox v${fetcher.verstr} installed.`, "green");
		rprint(`Path: ${installPath}`, "green");
		return true;
	} catch (e) {
		console.error(`Error installing Camoufox: ${e}`);
		throw e;
	} finally {
		// Best-effort teardown: a throw here would mask the real result.
		try {
			// Close before removing: Windows can't unlink a file with an open handle.
			if (!tempFileStream.closed) {
				await new Promise<void>((resolve) =>
					tempFileStream.close(() => resolve()),
				);
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
			fs.rmSync(stagingDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			console.error(`Failed to remove staging dir: ${cleanupErr}`);
		}
	}
}

/**
 * Remove a specific version installation. Empty repo folders are removed
 * too, and the active version moves to the newest remaining install.
 */
export function removeVersion(installPath: string): boolean {
	if (!fs.existsSync(installPath)) return false;

	rprint(`Removing: ${installPath}`);
	fs.rmSync(installPath, { recursive: true, force: true });

	const parent = path.dirname(installPath);
	if (
		fs.existsSync(parent) &&
		parent !== BROWSERS_DIR &&
		fs.readdirSync(parent).length === 0
	) {
		fs.rmdirSync(parent);
	}
	if (
		fs.existsSync(BROWSERS_DIR) &&
		fs.readdirSync(BROWSERS_DIR).length === 0
	) {
		fs.rmdirSync(BROWSERS_DIR);
	}

	const config = loadConfig();
	const relPath = path
		.relative(INSTALL_DIR, installPath)
		.split(path.sep)
		.join("/");
	if (config.active_version === relPath) {
		const remaining = listInstalled();
		config.active_version = remaining.length ? remaining[0].relativePath : null;
		saveConfig(config);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Short tag to tell coexisting installs apart: date or sha8 */
export function installedLabel(iv: InstalledVersion): string {
	if (iv.createdAt) {
		const date = formatAssetDate(iv.createdAt);
		if (date) return date;
	}
	return sha8(iv.sha256);
}

/** Print installed versions as a tree */
export function printTree({
	showHeader = true,
	showPaths = false,
}: {
	showHeader?: boolean;
	showPaths?: boolean;
} = {}): void {
	const installed = listInstalled();

	if (installed.length === 0) {
		rprint("No versions installed.", "yellow");
		rprint("Run `camoufox fetch` to install.", "yellow");
		return;
	}

	if (showHeader) rprint("Installed versions:\n", "yellow");

	let currentRepo: string | null = null;
	installed.forEach((v, i) => {
		const isLast =
			i === installed.length - 1 || installed[i + 1].repoName !== v.repoName;

		if (v.repoName !== currentRepo) {
			currentRepo = v.repoName;
			const suffix = showPaths
				? style(` -> ${path.join(BROWSERS_DIR, currentRepo)}`, "bright_black")
				: "";
			console.log(`${style(`${currentRepo}/`, "cyan", true)}${suffix}`);
		}

		const branch = isLast ? "└── " : "├── ";
		let line = `    ${branch}`;
		line += style(
			`v${v.version.fullString}`,
			v.isActive ? "green" : undefined,
			v.isActive,
		);
		line += v.isPrerelease
			? style(" (prerelease)", "yellow")
			: style(" (stable)", "blue");
		const tag = installedLabel(v);
		if (tag) line += style(` (${tag})`, "bright_black");
		if (v.isActive) line += style(" (active)", "green", true);
		console.log(line);
	});
}
