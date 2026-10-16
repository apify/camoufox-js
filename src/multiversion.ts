import * as fs from "node:fs";
import * as path from "node:path";
import { effectivePin, pinMatches, pinSpec } from "./browser-pin.js";
import { UnsupportedVersion } from "./exceptions.js";
import { INSTALL_DIR, SUPPORTED_RANGE, Version } from "./pkgman.js";

/**
 * The Python library's multi-version layout (multiversion.py), shared with it: builds live in
 * INSTALL_DIR/browsers/<repo>/<version>-<build>[-<sha8>]/ and config.json records the active
 * one and whether the user chose a channel or a build.
 */

// pkgman imports this module too, so paths are resolved on use rather than at load.
export const browsersDir = (): string =>
	path.join(INSTALL_DIR.toString(), "browsers");
export const configFile = (): string =>
	path.join(INSTALL_DIR.toString(), "config.json");
export const compatFlag = (): string =>
	path.join(INSTALL_DIR.toString(), ".0.5_FLAG");

export interface CamoufoxConfig {
	active_version?: string | null;
	channel?: string;
	pinned?: string;
	pinned_sha?: string;
	[key: string]: unknown;
}

export function loadConfig(): CamoufoxConfig {
	try {
		return JSON.parse(fs.readFileSync(configFile(), "utf-8"));
	} catch {
		return {};
	}
}

export function saveConfig(config: CamoufoxConfig): void {
	fs.mkdirSync(INSTALL_DIR, { recursive: true });
	// Through a rename, so a concurrent reader never sees a half-written file.
	const tmp = `${configFile()}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
	fs.renameSync(tmp, configFile());
}

export function setActive(relativePath: string): void {
	saveConfig({ ...loadConfig(), active_version: relativePath });
}

// Folder names of the Python library's repos.yml entries.
const REPO_NAMES: Record<string, string> = { "daijro/camoufox": "official" };

export function getRepoName(githubRepo: string): string {
	return REPO_NAMES[githubRepo] ?? githubRepo.split("/")[0].toLowerCase();
}

export function versionFolderName(
	version: string,
	build: string,
	sha256?: string,
): string {
	const base = `${version}-${build}`;
	return sha256 ? `${base}-${sha256.slice(0, 8)}` : base;
}

export interface InstalledVersion {
	repoName: string;
	version: Version;
	path: string;
	relativePath: string;
	isActive: boolean;
	isPrerelease: boolean;
	sha256?: string;
}

/**
 * Builds in browsers/, sorted by repo, then newest first.
 */
export function listInstalled(): InstalledVersion[] {
	const installed: InstalledVersion[] = [];
	if (!fs.existsSync(browsersDir())) return installed;
	const active = loadConfig().active_version;

	for (const repo of fs.readdirSync(browsersDir(), { withFileTypes: true })) {
		if (!repo.isDirectory() || repo.name.startsWith(".")) continue;
		const repoDir = path.join(browsersDir(), repo.name);
		for (const folder of fs.readdirSync(repoDir, { withFileTypes: true })) {
			const dir = path.join(repoDir, folder.name);
			const versionJson = path.join(dir, "version.json");
			if (!folder.isDirectory() || !fs.existsSync(versionJson)) continue;
			try {
				const data = JSON.parse(fs.readFileSync(versionJson, "utf-8"));
				const relativePath = `browsers/${repo.name}/${folder.name}`;
				installed.push({
					repoName: repo.name,
					version: Version.fromPath(dir),
					path: dir,
					relativePath,
					isActive: relativePath === active,
					isPrerelease: data.prerelease ?? false,
					sha256: data.sha256 ?? undefined,
				});
			} catch {
				// A corrupt version.json is not a usable install.
			}
		}
	}

	const compare = (a: Version, b: Version) =>
		a.lessThan(b) ? -1 : b.lessThan(a) ? 1 : 0;
	return installed.sort(
		(a, b) =>
			(a.repoName < b.repoName ? 1 : a.repoName > b.repoName ? -1 : 0) ||
			compare(b.version, a.version),
	);
}

/**
 * The build to launch: the pinned one unless the user explicitly chose another, else the
 * active one. Null when that build isn't installed. Unlike the Python library, it doesn't
 * record the result in config.json, as launches may run concurrently or from a read-only dir.
 */
export function getActivePath(): string | null {
	const config = loadConfig();
	const active = config.active_version;

	const pin = effectivePin(config);
	if (pin) {
		const inst = listInstalled().find((v) =>
			pinMatches(pin, v.repoName, v.version.version ?? "", v.version.release),
		);
		return inst?.path ?? null;
	}

	if (active) {
		const activePath = path.join(INSTALL_DIR.toString(), active);
		if (fs.existsSync(path.join(activePath, "version.json"))) {
			return activePath;
		}
	}

	if (!config.channel && !config.pinned) {
		const [newest] = listInstalled();
		if (newest) return newest.path;
	}

	return null;
}

export const repoCacheFile = (): string =>
	path.join(INSTALL_DIR.toString(), "repo_cache.json");

/**
 * A release asset as the Python library stores it in repo_cache.json.
 */
export interface CachedVersion {
	version: string;
	build: string;
	url: string;
	is_prerelease: boolean;
	asset_id?: number;
	asset_size?: number;
	asset_updated_at?: string;
	sha256?: string | null;
	created_at?: string;
}

interface RepoCache {
	repos?: { name: string; repo?: string; versions?: CachedVersion[] }[];
	[key: string]: unknown;
}

function loadRepoCache(): RepoCache | null {
	try {
		return JSON.parse(fs.readFileSync(repoCacheFile(), "utf-8"));
	} catch {
		return null;
	}
}

/**
 * The official repo's builds from the last `camoufox sync`, or null if it never ran.
 */
export function loadCachedVersions(): CachedVersion[] | null {
	const cache = loadRepoCache();
	if (!cache) return null;
	return (
		cache.repos?.find((r) => r.name.toLowerCase() === "official")?.versions ??
		[]
	);
}

/**
 * Replaces the official repo's builds, keeping whatever else the Python library synced.
 */
export function saveCachedVersions(versions: CachedVersion[]): void {
	const cache = loadRepoCache() ?? {};
	const others = (cache.repos ?? []).filter(
		(r) => r.name.toLowerCase() !== "official",
	);
	fs.mkdirSync(INSTALL_DIR, { recursive: true });
	fs.writeFileSync(
		repoCacheFile(),
		JSON.stringify(
			{
				...cache,
				repos: [
					{ name: "Official", repo: "daijro/camoufox", versions },
					...others,
				],
			},
			null,
			2,
		),
	);
}

/**
 * One entry per version-build, the most recently uploaded asset.
 */
export function latestPerBuild(versions: CachedVersion[]): CachedVersion[] {
	const best = new Map<string, CachedVersion>();
	for (const v of versions) {
		const key = `${v.version}-${v.build}`;
		const current = best.get(key);
		if (!current || (v.created_at ?? "") > (current.created_at ?? "")) {
			best.set(key, v);
		}
	}
	return [...best.values()];
}

/**
 * Resolves `<version>-<build>` (its newest asset) or `<version>-<build>-<sha8>` (that asset).
 */
export function resolveSpec(
	versions: CachedVersion[],
	spec: string,
): { entry: CachedVersion; sha256?: string } | null {
	for (const v of versions) {
		if (
			v.sha256 &&
			spec === `${v.version}-${v.build}-${v.sha256.slice(0, 8)}`
		) {
			return { entry: v, sha256: v.sha256 };
		}
	}
	const entry = latestPerBuild(versions).find(
		(v) => spec === `${v.version}-${v.build}`,
	);
	return entry ? { entry } : null;
}

export function channelPath(v: InstalledVersion): string {
	const channel = v.isPrerelease ? "prerelease" : "stable";
	return `${v.repoName}/${channel}/${v.version.fullString}`;
}

/**
 * Finds an installed build by channel path, relative path, build, full version or
 * repo/version, or the newest installed build of a repo/channel.
 */
export function findInstalled(specifier: string): InstalledVersion | null {
	const spec = specifier.toLowerCase();
	const parts = spec.split("/");
	const installed = listInstalled();
	for (const v of installed) {
		if (
			[
				channelPath(v),
				v.relativePath,
				v.version.release,
				v.version.fullString,
			].some((s) => s.toLowerCase() === spec) ||
			(parts.length === 2 &&
				v.repoName === parts[0] &&
				v.version.fullString.toLowerCase() === parts[1])
		) {
			return v;
		}
	}
	if (parts.length === 2 && ["stable", "prerelease"].includes(parts[1])) {
		const isPrerelease = parts[1] === "prerelease";
		return (
			installed.find(
				(v) => v.repoName === parts[0] && v.isPrerelease === isPrerelease,
			) ?? null
		);
	}
	return null;
}

export function removeVersion(v: InstalledVersion): void {
	fs.rmSync(v.path, { recursive: true, force: true });
	const repoDir = path.dirname(v.path);
	if (fs.readdirSync(repoDir).length === 0) fs.rmdirSync(repoDir);
	const config = loadConfig();
	if (config.active_version === v.relativePath) {
		saveConfig({
			...config,
			active_version: listInstalled()[0]?.relativePath ?? null,
		});
	}
}

export const isSupported = (v: CachedVersion) =>
	new Version(v.build, v.version).isSupported();

// The Python CLI's specifiers: `<version>-<build>[-<sha8>]`, `<repo>/<channel>`,
// `<repo>/<version>-<build>` and `<repo>/<channel>/<version>-<build>`.
export function parseSpecifier(specifier: string): {
	channel?: string;
	spec?: string;
} {
	const parts = specifier.toLowerCase().split("/");
	const spec = parts.length > 1 ? parts.at(-1) : parts[0];
	const channel = parts.length === 3 ? parts[1] : spec;
	if (parts.length > 3 || (parts.length > 1 && parts[0] !== "official")) {
		throw new Error(
			`Invalid specifier '${specifier}'. camoufox-js only installs builds of the official repo, e.g. official/stable or official/stable/152.0.4-beta.30.`,
		);
	}
	if (channel === "stable" || channel === "prerelease") {
		return parts.length === 3
			? { channel, spec: spec?.replace(/^v/, "") }
			: { channel };
	}
	if (parts.length === 3) {
		throw new Error(
			`Unknown channel '${channel}'. Use 'stable' or 'prerelease'.`,
		);
	}
	return { spec: spec?.replace(/^v/, "") };
}

export const latestInChannel = (versions: CachedVersion[], channel: string) =>
	versions.find(
		(v) => v.is_prerelease === (channel === "prerelease") && isSupported(v),
	);

/**
 * The given build, else the pinned build or the latest of the channel chosen with `set`,
 * else the build this release is tested with.
 */
export function selectBuild(
	versions: CachedVersion[],
	specifier?: string,
): CachedVersion {
	const config = loadConfig();
	const pin = effectivePin(config);
	let wanted: string;
	let target: CachedVersion | undefined;
	if (specifier) {
		const { channel, spec } = parseSpecifier(specifier);
		wanted = specifier;
		target = spec
			? resolveSpec(versions, spec)?.entry
			: latestInChannel(versions, channel ?? "stable");
	} else if (config.pinned) {
		wanted = `${config.channel}/${config.pinned}`;
		target = config.pinned_sha
			? versions.find((v) => v.sha256 === config.pinned_sha)
			: resolveSpec(versions, config.pinned)?.entry;
	} else if (pin) {
		wanted = pinSpec(pin);
		target = resolveSpec(versions, wanted)?.entry;
	} else {
		wanted = config.channel ?? "official/stable";
		target = latestInChannel(versions, wanted.split("/")[1] ?? "stable");
	}
	if (!target) {
		throw new Error(
			`Camoufox ${wanted} was not found in the official repo's releases for this platform.`,
		);
	}
	if (!isSupported(target)) {
		throw new UnsupportedVersion(
			`Camoufox v${target.version}-${target.build} is not supported by this release (supported range: ${SUPPORTED_RANGE}).`,
		);
	}
	return target;
}
