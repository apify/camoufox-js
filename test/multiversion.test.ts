import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CachedVersion } from "../src/multiversion";

let installDir: string;

beforeEach(() => {
	installDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-mvtest-"));
	vi.stubEnv("CAMOUFOX_INSTALL_DIR", installDir);
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.resetModules();
	fs.rmSync(installDir, { recursive: true, force: true });
});

const cached = (
	versionBuild: string,
	extra: Partial<CachedVersion> = {},
): CachedVersion => {
	const [version, build] = versionBuild.split(/-(.*)/);
	return {
		version,
		build,
		url: `https://example.com/${versionBuild}`,
		is_prerelease: false,
		...extra,
	};
};

// Newest first, as listAvailableVersions() returns them.
const VERSIONS = [
	cached("156.0.1-beta.34"),
	cached("152.0.4-beta.31", { sha256: "b".repeat(64), created_at: "2" }),
	cached("152.0.4-beta.31", { sha256: "a".repeat(64), created_at: "1" }),
	cached("152.0.4-beta.30", { sha256: "c".repeat(64) }),
	cached("152.0.4-beta.26", { is_prerelease: true }),
];

const writeConfig = (config: Record<string, unknown>) =>
	fs.writeFileSync(
		path.join(installDir, "config.json"),
		JSON.stringify(config),
	);

function writeInstall(relativePath: string, data: Record<string, unknown>) {
	const dir = path.join(installDir, relativePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify(data));
	return dir;
}

describe("parseSpecifier", () => {
	test.each([
		["152.0.4-beta.30", { spec: "152.0.4-beta.30" }],
		["v152.0.4-beta.30", { spec: "152.0.4-beta.30" }],
		["official/152.0.4-beta.30", { spec: "152.0.4-beta.30" }],
		["official/stable", { channel: "stable" }],
		["Official/Prerelease", { channel: "prerelease" }],
		[
			"official/stable/152.0.4-beta.30-5720d45b",
			{ channel: "stable", spec: "152.0.4-beta.30-5720d45b" },
		],
	])("parses %s", async (specifier, expected) => {
		const { parseSpecifier } = await import("../src/multiversion");
		expect(parseSpecifier(specifier)).toEqual(expected);
	});

	test.each([
		"coryking/stable",
		"official/nightly/152.0.4-beta.30",
		"a/b/c/d",
	])("rejects %s", async (specifier) => {
		const { parseSpecifier } = await import("../src/multiversion");
		expect(() => parseSpecifier(specifier)).toThrow();
	});
});

describe("resolveSpec", () => {
	test("picks the newest asset of a build, or the one named by its sha8", async () => {
		const { resolveSpec } = await import("../src/multiversion");
		expect(resolveSpec(VERSIONS, "152.0.4-beta.31")?.entry.sha256).toBe(
			"b".repeat(64),
		);
		expect(resolveSpec(VERSIONS, "152.0.4-beta.31-aaaaaaaa")).toEqual({
			entry: VERSIONS[2],
			sha256: "a".repeat(64),
		});
		expect(resolveSpec(VERSIONS, "152.0.4-beta.99")).toBeNull();
	});
});

describe("selectBuild", () => {
	test("selects the pinned build by default", async () => {
		const { selectBuild } = await import("../src/multiversion");
		const pin = (await import("../src/browser-pin")).loadPin();
		const selected = selectBuild(VERSIONS);
		expect(`${selected.version}-${selected.build}`).toBe(
			`${pin?.version}-${pin?.build}`,
		);
	});

	test("follows the newest supported build of a chosen channel", async () => {
		writeConfig({ channel: "official/stable" });
		const { selectBuild } = await import("../src/multiversion");
		expect(selectBuild(VERSIONS)).toBe(VERSIONS[1]);
	});

	test("installs the exact asset a chosen build was pinned to", async () => {
		writeConfig({
			channel: "official/stable",
			pinned: "152.0.4-beta.31",
			pinned_sha: "a".repeat(64),
		});
		const { selectBuild } = await import("../src/multiversion");
		expect(selectBuild(VERSIONS)).toBe(VERSIONS[2]);
	});

	test("rejects unsupported and unknown builds", async () => {
		const { selectBuild } = await import("../src/multiversion");
		const { UnsupportedVersion } = await import("../src/exceptions");
		expect(() => selectBuild(VERSIONS, "156.0.1-beta.34")).toThrow(
			UnsupportedVersion,
		);
		expect(() => selectBuild(VERSIONS, "152.0.4-beta.99")).toThrow(
			"was not found",
		);
	});
});

describe("repo cache", () => {
	test("keeps what the Python library synced for other repos", async () => {
		fs.writeFileSync(
			path.join(installDir, "repo_cache.json"),
			JSON.stringify({
				spoof_os: null,
				repos: [
					{ name: "Official", repo: "daijro/camoufox", versions: [] },
					{ name: "CoryKing", repo: "coryking/camoufox", versions: [] },
				],
			}),
		);
		const { loadCachedVersions, saveCachedVersions } = await import(
			"../src/multiversion"
		);
		saveCachedVersions(VERSIONS);
		expect(loadCachedVersions()).toEqual(VERSIONS);
		const cache = JSON.parse(
			fs.readFileSync(path.join(installDir, "repo_cache.json"), "utf-8"),
		);
		expect(cache.spoof_os).toBeNull();
		expect(cache.repos.map((r: { name: string }) => r.name)).toEqual([
			"Official",
			"CoryKing",
		]);
	});
});

describe("findInstalled and removeVersion", () => {
	test("removes one build and moves the active one", async () => {
		writeInstall("browsers/official/152.0.4-beta.30-5720d45b", {
			version: "152.0.4",
			build: "beta.30",
		});
		const beta31 = writeInstall("browsers/official/152.0.4-beta.31", {
			version: "152.0.4",
			build: "beta.31",
		});
		writeConfig({ active_version: "browsers/official/152.0.4-beta.31" });
		const { findInstalled, loadConfig, removeVersion } = await import(
			"../src/multiversion"
		);
		const target = findInstalled("official/stable/152.0.4-beta.31");
		expect(target?.path).toBe(beta31);
		expect(findInstalled("beta.30")?.version.release).toBe("beta.30");
		expect(findInstalled("official/stable")?.path).toBe(beta31);

		if (!target) throw new Error("beta.31 must be found");
		removeVersion(target);
		expect(fs.existsSync(beta31)).toBe(false);
		expect(loadConfig().active_version).toBe(
			"browsers/official/152.0.4-beta.30-5720d45b",
		);
	});
});

describe("listAvailableVersions", () => {
	test("lists every build for this platform, newest first", async () => {
		const { CamoufoxFetcher, listAvailableVersions, OS_NAME } = await import(
			"../src/pkgman"
		);
		const suffix = `${OS_NAME}.${CamoufoxFetcher.getPlatformArch()}.zip`;
		const asset = (versionBuild: string, extra = {}) => ({
			name: `camoufox-${versionBuild}-${suffix}`,
			browser_download_url: `https://example.com/${versionBuild}`,
			...extra,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => [
					{ draft: true, assets: [asset("156.0.1-beta.99")] },
					{ prerelease: true, assets: [asset("156.0.1-beta.35")] },
					{
						assets: [
							asset("152.0.4-beta.30", { digest: `sha256:${"c".repeat(64)}` }),
							{ name: "camoufox-152.0.4-beta.30-other.zip" },
						],
					},
					{ assets: [asset("152.0.4-alpha.25")] },
				],
			})),
		);
		const versions = await listAvailableVersions();
		expect(
			versions.map((v) => [v.version, v.build, v.is_prerelease, v.sha256]),
		).toEqual([
			["156.0.1", "beta.35", true, null],
			["152.0.4", "beta.30", false, "c".repeat(64)],
			["152.0.4", "alpha.25", true, null],
		]);
	});
});

describe("installedVerStr", () => {
	test("warns once when launching an explicitly chosen build", async () => {
		writeInstall("browsers/official/152.0.4-beta.31", {
			version: "152.0.4",
			build: "beta.31",
		});
		writeConfig({
			channel: "official/stable",
			pinned: "152.0.4-beta.31",
			active_version: "browsers/official/152.0.4-beta.31",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { installedVerStr } = await import("../src/pkgman");
		expect(installedVerStr()).toBe("152.0.4-beta.31");
		installedVerStr();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("camoufox set --release");
	});
});
