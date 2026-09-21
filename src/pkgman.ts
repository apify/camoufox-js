import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import AdmZip from "adm-zip";
import cliProgress, { type Options } from "cli-progress";
import prettyBytes from "pretty-bytes";
import { CONSTRAINTS } from "./__version__.js";
import {
	CamoufoxNotInstalled,
	CorruptedDownload,
	FileNotFoundError,
	MissingRelease,
	UnsupportedArchitecture,
	UnsupportedOS,
	UnsupportedVersion,
} from "./exceptions.js";
import {
	COMPAT_FLAG,
	getActivePath,
	getDefaultChannel,
	installVersioned,
	loadConfig,
	resolveActiveTarget,
	syncRepos,
	toAvailableVersion,
} from "./multiversion.js";
import {
	ARCH_MAP,
	getAsBooleanFromENV,
	INSTALL_DIR,
	LAUNCH_FILE,
	LOCAL_DATA,
	OS_ARCH_MATRIX,
	OS_MAP,
	OS_NAME,
	type OsName,
	userCacheDir,
} from "./platform.js";
import {
	BROWSER_REPOS,
	type ChannelBounds,
	DEFAULT_BROWSER_REPO,
	type RepoDefinition,
} from "./repos.js";

export {
	ARCH_MAP,
	INSTALL_DIR,
	LOCAL_DATA,
	OS_ARCH_MATRIX,
	OS_MAP,
	OS_NAME,
	userCacheDir,
};

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

export type Color =
	| "green"
	| "yellow"
	| "red"
	| "cyan"
	| "blue"
	| "bright_black";

const ANSI: Record<Color, string> = {
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	blue: "\x1b[34m",
	bright_black: "\x1b[90m",
};

function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return !!process.stdout.isTTY;
}

/**
 * Wrap text in ANSI color/bold codes when the terminal supports it.
 */
export function style(text: string, fg?: Color, bold = false): string {
	if (!colorEnabled() || (!fg && !bold)) return text;
	const prefix = `${bold ? "\x1b[1m" : ""}${fg ? ANSI[fg] : ""}`;
	return `${prefix}${text}\x1b[0m`;
}

/**
 * Print a styled message (port of Python's `rprint`).
 */
export function rprint(msg: string, fg?: Color, nl = true): void {
	const text = style(msg, fg, true);
	if (nl) {
		console.log(text);
	} else {
		process.stdout.write(text);
	}
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * A comparable version string (up to 5 parts), e.g. build `beta.25` of
 * Firefox `135.0`.
 */
export class Version {
	build: string;
	version?: string;
	sorted_rel: number[];

	constructor(build: string, version?: string) {
		this.build = build;
		this.version = version;
		this.sorted_rel = this.buildSortedRel();
	}

	private buildSortedRel(): number[] {
		const parts = this.build
			.split(".")
			.map((x) =>
				Number.isNaN(Number(x)) ? x.charCodeAt(0) - 1024 : Number(x),
			);
		while (parts.length < 5) {
			parts.push(0);
		}
		return parts;
	}

	get fullString(): string {
		return `${this.version}-${this.build}`;
	}

	/** Whether the build channel is alpha (like `alpha.26`). */
	get isAlpha(): boolean {
		return this.build.split(".")[0].toLowerCase() === "alpha";
	}

	compare(other: Version): number {
		const len = Math.max(this.sorted_rel.length, other.sorted_rel.length);
		for (let i = 0; i < len; i++) {
			const a = this.sorted_rel[i] ?? 0;
			const b = other.sorted_rel[i] ?? 0;
			if (a < b) return -1;
			if (a > b) return 1;
		}
		return 0;
	}

	equals(other: Version): boolean {
		return this.compare(other) === 0;
	}

	lessThan(other: Version): boolean {
		return this.compare(other) < 0;
	}

	lessOrEqual(other: Version): boolean {
		return this.compare(other) <= 0;
	}

	isSupported(): boolean {
		return VERSION_MIN.lessOrEqual(this) && this.lessThan(VERSION_MAX);
	}

	/**
	 * Read the version from `version.json` at the given path. Accepts the
	 * `build` key written by this and the Python library, plus the legacy
	 * `release`/`tag` keys from older installs.
	 */
	static fromPath(filePath: PathLike = INSTALL_DIR): Version {
		const versionPath = path.join(filePath.toString(), "version.json");
		if (!fs.existsSync(versionPath)) {
			throw new FileNotFoundError(
				`Version information not found at ${versionPath}. Please run \`camoufox fetch\` to install.`,
			);
		}
		const versionData = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
		const build = versionData.build ?? versionData.release ?? versionData.tag;
		return new Version(build, versionData.version);
	}

	static isSupportedPath(path: PathLike): boolean {
		return Version.fromPath(path).isSupported();
	}

	static buildMinMax(): [Version, Version] {
		return [
			new Version(CONSTRAINTS.MIN_VERSION),
			new Version(CONSTRAINTS.MAX_VERSION),
		];
	}
}

const [VERSION_MIN, VERSION_MAX] = Version.buildMinMax();

// ---------------------------------------------------------------------------
// Repository configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a Camoufox repository (port of Python's `RepoConfig`).
 */
export class RepoConfig {
	constructor(
		/** Primary + fallback GitHub repos */
		public repos: string[],
		public name: string,
		public pattern: string,
		public stableMin?: string,
		public stableMax?: string,
		public prereleaseMin?: string,
		public prereleaseMax?: string,
	) {}

	/** Primary GitHub repo */
	get repo(): string {
		return this.repos[0];
	}

	static loadRepos(): RepoConfig[] {
		return BROWSER_REPOS.map((r) => RepoConfig.fromDefinition(r));
	}

	static getDefaultName(): string {
		return DEFAULT_BROWSER_REPO;
	}

	static fromDefinition(d: RepoDefinition): RepoConfig {
		if (!d.pattern) {
			throw new Error(`Repo '${d.name}' missing required pattern`);
		}
		const bounds = (b?: ChannelBounds): [string?, string?] => [b?.min, b?.max];
		const [stableMin, stableMax] = bounds(d.browser?.stable);
		const [prereleaseMin, prereleaseMax] = bounds(d.browser?.prerelease);
		return new RepoConfig(
			d.repo,
			d.name,
			d.pattern,
			stableMin,
			stableMax,
			prereleaseMin,
			prereleaseMax,
		);
	}

	static getDefault(): RepoConfig {
		return (
			RepoConfig.findByName(RepoConfig.getDefaultName()) ??
			RepoConfig.loadRepos()[0]
		);
	}

	/** Find a repo config by name (case-insensitive) */
	static findByName(name: string): RepoConfig | undefined {
		const lower = name.toLowerCase();
		return RepoConfig.loadRepos().find((r) => r.name.toLowerCase() === lower);
	}

	getOsName(spoofOs?: string): string {
		if (spoofOs) return spoofOs;
		const osName = OS_MAP[process.platform];
		if (!osName) {
			throw new UnsupportedOS(`OS ${process.platform} is not supported`);
		}
		return osName;
	}

	getArch(spoofArch?: string): string {
		if (spoofArch) return spoofArch;
		const platArch = os.arch().toLowerCase();
		const arch = ARCH_MAP[platArch];
		if (!arch) {
			throw new UnsupportedArchitecture(
				`Architecture ${platArch} is not supported`,
			);
		}
		return arch;
	}

	/** Build the asset regex from the config pattern string */
	buildPattern(spoofOs?: string, spoofArch?: string): RegExp {
		const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const replacements: Record<string, string> = {
			name: "(?<name>\\w+)",
			version: "(?<version>[^-]+)",
			build: "(?<build>[^-]+)",
			os: escapeRegex(this.getOsName(spoofOs)),
			arch: escapeRegex(this.getArch(spoofArch)),
		};
		const regex = this.pattern
			.replace(/\./g, "\\.")
			.replace(/\{(\w+)\}/g, (m, key) => replacements[key] ?? m);
		return new RegExp(`^${regex}`);
	}

	/** Check if a build is within the supported range for its channel */
	isVersionSupported(version: Version, isPrerelease = false): boolean {
		const [min, max] = isPrerelease
			? [this.prereleaseMin, this.prereleaseMax]
			: [this.stableMin, this.stableMax];
		if (min === undefined || max === undefined) return true;
		return (
			new Version(min).lessOrEqual(version) &&
			version.lessOrEqual(new Version(max))
		);
	}
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function getAuthorizationHeaders(url: string): HeadersInit {
	const githubToken = process.env.GITHUB_TOKEN;
	if (!githubToken) return {};
	const host = new URL(url).hostname;
	if (host === "api.github.com" || host === "github.com") {
		return { Authorization: `Bearer ${githubToken}` };
	}
	return {};
}

async function fetchWithRetry(
	url: string,
	retries: number,
	what: string,
): Promise<Response> {
	let attempts = 0;
	let response: Response | undefined;

	while (attempts < retries) {
		try {
			response = await fetch(url, { headers: getAuthorizationHeaders(url) });
			if (response.ok) break;
		} catch (e) {
			console.error(e, `retrying (${attempts + 1}/${retries})...`);
			await setTimeout(5e3);
		}
		attempts++;
	}

	if (!response || !response.ok) {
		const status = response ? ` (HTTP ${response.status})` : "";
		throw new Error(
			`Failed to ${what} ${url} after ${retries} attempts${status}`,
		);
	}
	return response;
}

/**
 * Fetch the release list of a GitHub repository.
 */
export async function getReleases(
	githubRepo: string,
	{ retries }: { retries: number } = { retries: 5 },
): Promise<any[]> {
	const apiUrl = `https://api.github.com/repos/${githubRepo}/releases`;
	const response = await fetchWithRetry(apiUrl, retries, "fetch releases from");
	return await response.json();
}

/**
 * Manages fetching GitHub releases with fallback repos.
 */
export class GitHubDownloader {
	githubRepos: string[];
	githubRepo: string;
	isPrerelease = false;

	constructor(githubRepos: string | string[]) {
		this.githubRepos =
			typeof githubRepos === "string" ? [githubRepos] : githubRepos;
		this.githubRepo = this.githubRepos[0];
	}

	get apiUrl(): string {
		return `https://api.github.com/repos/${this.githubRepo}/releases`;
	}

	/** Return truthy data if this is the desired asset, else null */
	checkAsset(asset: any, _release?: any): any {
		return asset.browser_download_url;
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`Could not find a release asset in ${this.githubRepo}.`,
		);
	}

	/**
	 * Fetch the first matching release asset, trying fallback repos on failure.
	 * Draft and prerelease releases are skipped.
	 */
	async getAsset(
		{ retries }: { retries: number } = { retries: 5 },
	): Promise<any> {
		let lastError: unknown;
		for (const repo of this.githubRepos) {
			try {
				const releases = await getReleases(repo, { retries });
				for (const release of releases) {
					if (release.prerelease || release.draft) continue;
					for (const asset of release.assets) {
						const data = this.checkAsset(asset, release);
						if (data) {
							this.githubRepo = repo;
							this.isPrerelease = !!release.prerelease;
							return data;
						}
					}
				}
			} catch (e) {
				lastError = e;
			}
		}
		if (lastError) throw lastError;
		this.missingAssetError();
	}
}

// ---------------------------------------------------------------------------
// Available versions
// ---------------------------------------------------------------------------

/**
 * Information about an available Camoufox version from GitHub.
 */
export interface AvailableVersion {
	version: Version;
	url: string;
	isPrerelease: boolean;
	// GitHub metadata for tracking changes
	assetId?: number | null;
	assetSize?: number | null;
	assetUpdatedAt?: string | null;
	sha256?: string | null;
	assetCreatedAt?: string | null;
}

/** Metadata stored in `version.json` (snake_case, shared with the Python library). */
export interface VersionMetadata {
	version?: string;
	build: string;
	prerelease?: boolean;
	asset_id?: number | null;
	asset_size?: number | null;
	asset_updated_at?: string | null;
	sha256?: string | null;
	created_at?: string | null;
}

/** First 8 hex chars of a sha256, or empty when unknown */
export function sha8(sha256?: string | null): string {
	return (sha256 ?? "").slice(0, 8);
}

export function availableVersionDisplay(v: AvailableVersion): string {
	return `v${v.version.fullString}${v.isPrerelease ? " (prerelease)" : ""}`;
}

export function availableVersionMetadata(v: AvailableVersion): VersionMetadata {
	return {
		version: v.version.version,
		build: v.version.build,
		prerelease: v.isPrerelease,
		asset_id: v.assetId ?? null,
		asset_size: v.assetSize ?? null,
		asset_updated_at: v.assetUpdatedAt ?? null,
		sha256: v.sha256 ?? null,
		created_at: v.assetCreatedAt ?? null,
	};
}

/**
 * Fetch all supported versions from GitHub for the current (or spoofed)
 * platform, newest first.
 */
export async function listAvailableVersions({
	repoConfig,
	includePrerelease = true,
	spoofOs,
	spoofArch,
}: {
	repoConfig?: RepoConfig;
	includePrerelease?: boolean;
	spoofOs?: string;
	spoofArch?: string;
} = {}): Promise<AvailableVersion[]> {
	const config = repoConfig ?? RepoConfig.getDefault();
	const pattern = config.buildPattern(spoofOs, spoofArch);

	const osName = spoofOs ?? OS_NAME;
	const arch = config.getArch(spoofArch);
	if (!(OS_ARCH_MATRIX[osName] ?? []).includes(arch)) {
		throw new UnsupportedArchitecture(
			`Architecture ${arch} is not supported for ${osName}`,
		);
	}

	let releases: any[] = [];
	let lastError: unknown;
	for (const repo of config.repos) {
		try {
			releases = await getReleases(repo);
			break;
		} catch (e) {
			lastError = e;
		}
	}
	if (releases.length === 0 && lastError) throw lastError;

	const versions: AvailableVersion[] = [];
	for (const release of releases) {
		if (release.draft) continue;
		const releasePrerelease = !!release.prerelease;
		if (releasePrerelease && !includePrerelease) continue;

		for (const asset of release.assets ?? []) {
			const match = pattern.exec(asset.name);
			if (!match?.groups) continue;

			const version = new Version(match.groups.build, match.groups.version);
			const isPrerelease = releasePrerelease || version.isAlpha;
			if (isPrerelease && !includePrerelease) continue;
			if (!config.isVersionSupported(version, isPrerelease)) continue;

			versions.push({
				version,
				url: asset.browser_download_url,
				isPrerelease,
				assetId: asset.id ?? null,
				assetSize: asset.size ?? null,
				assetUpdatedAt: asset.updated_at ?? null,
				sha256: parseDigest(asset.digest),
				assetCreatedAt: asset.created_at ?? null,
			});
		}
	}

	versions.sort(
		(a, b) =>
			b.version.compare(a.version) ||
			(b.assetCreatedAt ?? "").localeCompare(a.assetCreatedAt ?? ""),
	);
	return versions;
}

function parseDigest(digest?: string | null): string | null {
	if (digest?.startsWith("sha256:")) {
		return digest.slice("sha256:".length);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Handles fetching and installing Camoufox.
 */
export class CamoufoxFetcher extends GitHubDownloader {
	repoConfig: RepoConfig;
	arch: string;
	pattern: RegExp;
	_version_obj?: Version;
	_url?: string;
	_selected_version?: AvailableVersion;
	installedSha256?: string | null;
	installedCreatedAt?: string | null;

	constructor(repoConfig?: RepoConfig, selectedVersion?: AvailableVersion) {
		const config = repoConfig ?? RepoConfig.getDefault();
		super(config.repos);
		this.repoConfig = config;
		this.arch = CamoufoxFetcher.getPlatformArch(config);
		this.pattern = config.buildPattern();

		if (selectedVersion) {
			this.selectVersion(selectedVersion);
		}
	}

	/** Use a specific catalog entry instead of the latest release. */
	selectVersion(selected: AvailableVersion): void {
		this._selected_version = selected;
		this._version_obj = selected.version;
		this._url = selected.url;
		this.isPrerelease = selected.isPrerelease;
		this.installedSha256 = selected.sha256 ?? null;
		this.installedCreatedAt = selected.assetCreatedAt ?? null;
	}

	/**
	 * Build a fetcher for whatever the user configuration points at: the
	 * pinned version, or the latest release in the active channel
	 * (`official/stable` by default). Syncs the repo cache first.
	 */
	static async fromConfig(): Promise<CamoufoxFetcher> {
		const cache = await syncRepos({ quiet: true });
		const target = resolveActiveTarget(cache, loadConfig());
		if (!target.repoData || !target.verData) {
			throw new MissingRelease(
				target.error ??
					`No matching release found for ${OS_NAME} in '${target.display}'.`,
			);
		}
		const repoConfig = RepoConfig.findByName(target.repoData.name);
		return new CamoufoxFetcher(repoConfig, toAvailableVersion(target.verData));
	}

	async init(): Promise<void> {
		if (this._version_obj) return;
		await this.fetchLatest();
	}

	/** First 8 hex chars of the installed asset sha, or empty */
	get installedSha8(): string {
		return sha8(this.installedSha256);
	}

	checkAsset(asset: any, release?: any): [Version, string] | null {
		const match = this.pattern.exec(asset.name);
		if (!match?.groups) return null;

		const version = new Version(match.groups.build, match.groups.version);
		const isPrerelease = !!release?.prerelease || version.isAlpha;
		if (!this.repoConfig.isVersionSupported(version, isPrerelease)) {
			return null;
		}

		this.installedSha256 = parseDigest(asset.digest);
		this.installedCreatedAt = asset.created_at ?? null;

		return [version, asset.browser_download_url];
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`No matching release found for ${OS_NAME} ${this.arch} in the supported range: (${CONSTRAINTS.asRange()}). Please update the library.`,
		);
	}

	static getPlatformArch(repoConfig?: RepoConfig): string {
		const arch = (repoConfig ?? RepoConfig.getDefault()).getArch();
		if (!OS_ARCH_MATRIX[OS_NAME].includes(arch)) {
			throw new UnsupportedArchitecture(
				`Architecture ${arch} is not supported for ${OS_NAME}`,
			);
		}
		return arch;
	}

	/**
	 * Fetch the latest stable Camoufox release of this repository for the
	 * current platform (falling back to a prerelease if no stable exists).
	 */
	async fetchLatest(): Promise<void> {
		const versions = await listAvailableVersions({
			repoConfig: this.repoConfig,
			includePrerelease: true,
		});
		const latest =
			versions.find((v) => !v.isPrerelease) ?? versions[0] ?? undefined;
		if (!latest) {
			this.missingAssetError();
			return;
		}
		this.selectVersion(latest);
	}

	static async downloadFile(url: string): Promise<Buffer> {
		const response = await fetch(url, {
			headers: getAuthorizationHeaders(url),
		});
		return Buffer.from(await response.arrayBuffer());
	}

	async extractZip(
		zipFile: string | Buffer,
		destDir: string = INSTALL_DIR,
	): Promise<void> {
		const zip = new AdmZip(zipFile);
		zip.extractAllTo(destDir, true);
	}

	/** Remove the whole Camoufox data directory */
	static cleanup(): boolean {
		if (fs.existsSync(INSTALL_DIR)) {
			fs.rmSync(INSTALL_DIR, { recursive: true });
			return true;
		}
		return false;
	}

	/** Metadata to write into `version.json` of the install */
	get metadata(): VersionMetadata {
		if (this._selected_version) {
			return availableVersionMetadata(this._selected_version);
		}
		return {
			version: this.version,
			build: this.build,
			prerelease: this.isPrerelease,
			sha256: this.installedSha256 ?? null,
			created_at: this.installedCreatedAt ?? null,
		};
	}

	setVersion(destDir: string = INSTALL_DIR): void {
		fs.writeFileSync(
			path.join(destDir, "version.json"),
			JSON.stringify(this.metadata),
		);
	}

	/**
	 * Download and install Camoufox to `browsers/<repo>/<version>-<build>-<sha8>`
	 * and make it the active version. Returns false when it was already
	 * installed and `replace` is not set.
	 */
	async install({
		replace = false,
	}: {
		replace?: boolean;
	} = {}): Promise<boolean> {
		await this.init();
		return installVersioned(this, { replace });
	}

	get url(): string {
		if (!this._url) {
			throw new Error(
				"Url is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._url;
	}

	get version(): string {
		if (!this._version_obj || !this._version_obj.version) {
			throw new Error(
				"Version is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._version_obj.version;
	}

	get build(): string {
		if (!this._version_obj) {
			throw new Error(
				"Build information is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.build;
	}

	get verstr(): string {
		if (!this._version_obj) {
			throw new Error(
				"Version is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.fullString;
	}
}

// ---------------------------------------------------------------------------
// Resolving the installed browser
// ---------------------------------------------------------------------------

function activeDisplay(): string {
	const config = loadConfig();
	const channel = config.channel ?? getDefaultChannel();
	return config.pinned ? `${channel}/${config.pinned}` : channel;
}

/**
 * Get the full version string of the active install.
 */
export function installedVerStr(): string {
	const active = getActivePath();
	if (active === null) {
		if (rootInstallSupported()) {
			return Version.fromPath(INSTALL_DIR).fullString;
		}
		throw new CamoufoxNotInstalled(
			`${activeDisplay()} is not installed. Please run \`camoufox fetch\` to install.`,
		);
	}
	return Version.fromPath(active).fullString;
}

/**
 * Whether INSTALL_DIR's root holds a supported build (the pre-multiversion
 * flat layout wrote `version.json` at the root).
 */
function rootInstallSupported(): boolean {
	try {
		return Version.fromPath(INSTALL_DIR).isSupported();
	} catch (e) {
		if (e instanceof FileNotFoundError) return false;
		throw e;
	}
}

/**
 * Remove an install directory laid out by a version of this library that
 * predates side-by-side versions: the browser was extracted straight into
 * INSTALL_DIR, with `version.json` at its root. Mirrors the Python library's
 * "Cleaning old data" step, but only fires on that legacy marker so a
 * directory holding just `config.json`/`repo_cache.json` is left alone.
 */
export function cleanOldData(): boolean {
	if (
		fs.existsSync(path.join(INSTALL_DIR, "version.json")) &&
		!fs.existsSync(COMPAT_FLAG)
	) {
		rprint("Cleaning old data...", "yellow");
		fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
		return true;
	}
	return false;
}

/**
 * Full path to the active Camoufox folder. Throws when nothing usable is
 * installed; use {@link ensureCamoufoxInstalled} to download on demand.
 */
export function camoufoxPath(): string {
	const active = getActivePath();
	if (active && Version.fromPath(active).isSupported()) {
		return active;
	}

	if (!fs.existsSync(INSTALL_DIR) || fs.readdirSync(INSTALL_DIR).length === 0) {
		throw new CamoufoxNotInstalled(
			`${activeDisplay()} is not installed. Please run \`camoufox fetch\` to install.`,
		);
	}
	if (rootInstallSupported()) {
		return INSTALL_DIR;
	}
	if (active) {
		throw new UnsupportedVersion(
			`Camoufox executable at ${active} is outdated. Please run \`camoufox fetch\` to update.`,
		);
	}
	throw new CamoufoxNotInstalled(
		`${activeDisplay()} is not installed. Please run \`camoufox fetch\` to install.`,
	);
}

/**
 * Resolve the active Camoufox folder, downloading the configured version
 * first when it is missing or unsupported.
 */
export async function ensureCamoufoxInstalled(): Promise<string> {
	cleanOldData();

	try {
		return camoufoxPath();
	} catch (e) {
		if (
			!(e instanceof CamoufoxNotInstalled) &&
			!(e instanceof UnsupportedVersion)
		) {
			throw e;
		}
		if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
			throw new CamoufoxNotInstalled(
				`${activeDisplay()} is not installed at ${INSTALL_DIR} and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set. Provision it before launching (\`camoufox fetch\`).`,
			);
		}
	}

	const fetcher = await CamoufoxFetcher.fromConfig();
	await fetcher.install();

	// Re-check rather than recurse: if the newest published build is still
	// below this library's floor, say what is actually wrong.
	const active = getActivePath();
	if (active && Version.fromPath(active).isSupported()) {
		return active;
	}
	throw new UnsupportedVersion(
		`No available Camoufox build satisfies this library's minimum (${CONSTRAINTS.MIN_VERSION}). The matching browser release may not be published yet; wait for it, or install an older camoufox-js release.`,
	);
}

/**
 * Get the path to a file in the active Camoufox directory.
 */
export function getPath(file: string): string {
	if (OS_NAME === "mac") {
		return path.resolve(
			camoufoxPath(),
			"Camoufox.app",
			"Contents",
			"Resources",
			file,
		);
	}
	return path.join(camoufoxPath(), file);
}

/**
 * Get the path to the Camoufox executable.
 */
export function launchPath(browserPath?: string): string {
	let execPath: string;
	if (browserPath) {
		execPath =
			OS_NAME === "mac"
				? path.resolve(
						browserPath,
						"Camoufox.app",
						"Contents",
						"Resources",
						LAUNCH_FILE[OS_NAME],
					)
				: path.join(browserPath, LAUNCH_FILE[OS_NAME]);
	} else {
		execPath = getPath(LAUNCH_FILE[OS_NAME]);
	}

	if (!fs.existsSync(execPath)) {
		throw new CamoufoxNotInstalled(
			`Camoufox is not installed at ${browserPath ?? camoufoxPath()}. Please run \`camoufox fetch\` to install.`,
		);
	}
	return execPath;
}

// ---------------------------------------------------------------------------
// Download / extract helpers
// ---------------------------------------------------------------------------

const formatBytes = (v: number, _: Options, type: string) =>
	type === "total" || type === "value" ? prettyBytes(v) : String(v);

export async function webdl(
	url: string,
	desc: string = "",
	bar: boolean = true,
	buffer: Writable | null = null,
	{ retries }: { retries: number } = { retries: 5 },
): Promise<Buffer> {
	const response = await fetchWithRetry(url, retries, "download from");

	const totalSize = parseInt(response.headers.get("content-length") || "0", 10);
	let progressBar: cliProgress.SingleBar | null = null;
	if (bar && totalSize > 0) {
		progressBar = new cliProgress.SingleBar(
			{
				format: `${desc} [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total}`,
				formatValue: formatBytes,
				noTTYOutput: true,
			},
			cliProgress.Presets.shades_classic,
		);
		progressBar.start(totalSize, 0);
	}

	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of response.body!) {
			if (buffer) {
				buffer.write(chunk);
			} else {
				chunks.push(chunk);
			}
			if (progressBar) {
				progressBar.increment(chunk.length);
			}
		}
	} finally {
		progressBar?.stop();
	}

	return Buffer.concat(chunks);
}

/**
 * Check a downloaded file against its expected sha256 digest.
 *
 * Throws CorruptedDownload on mismatch. Skips (with a warning) when no digest
 * is known, so installs from sources that publish no digest still work.
 */
export async function verifySha256(
	filePath: string,
	expected: string | null | undefined,
	desc = "asset",
): Promise<void> {
	if (!expected) {
		rprint(
			`Warning: no sha256 published for ${desc}; skipping verification.`,
			"yellow",
		);
		return;
	}

	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(filePath)) {
		hash.update(chunk as Buffer);
	}
	const actual = hash.digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new CorruptedDownload(
			`Checksum mismatch for ${desc}.\n` +
				`  expected sha256: ${expected.toLowerCase()}\n` +
				`  actual   sha256: ${actual}\n` +
				"The download was corrupted or tampered with. Installation aborted.",
		);
	}
}

export async function unzip(
	zipFile: Buffer,
	extractPath: string,
	desc?: string,
	bar: boolean = true,
): Promise<void> {
	const zip = new AdmZip(zipFile);
	const zipEntries = zip.getEntries();

	if (bar) {
		console.log(desc || "Extracting files...");
	}

	for (const entry of zipEntries) {
		if (bar) {
			console.log(`Extracting ${entry.entryName}`);
		}
		zip.extractEntryTo(entry, extractPath, true, true);
	}

	if (bar) {
		console.log("Extraction complete.");
	}
}

/**
 * Format an asset timestamp as `Mon D`, or `Mon D, YYYY` when the year differs.
 */
export function formatAssetDate(
	iso?: string | null,
	now: Date = new Date(),
): string {
	if (!iso) return "";
	const dt = new Date(iso);
	if (Number.isNaN(dt.getTime())) return "";
	const month = dt.toLocaleString("en-US", { month: "short" });
	if (dt.getFullYear() === now.getFullYear()) {
		return `${month} ${dt.getDate()}`;
	}
	return `${month} ${dt.getDate()}, ${dt.getFullYear()}`;
}

export type { OsName };
