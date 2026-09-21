import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CachedRepo, CachedVersion, RepoCache } from "../src/multiversion";

function cached(
	version: string,
	build: string,
	extra: Partial<CachedVersion> = {},
): CachedVersion {
	return {
		version,
		build,
		url: `https://example.test/camoufox-${version}-${build}.zip`,
		is_prerelease: false,
		sha256: null,
		created_at: "2026-01-01T00:00:00Z",
		...extra,
	};
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function officialRepo(): CachedRepo {
	return {
		name: "Official",
		repo: "daijro/camoufox",
		versions: [
			cached("137.0", "beta.27", { is_prerelease: true }),
			// Two dated assets of the same build; the newer one wins
			cached("136.0", "beta.26", {
				sha256: SHA_B,
				created_at: "2026-02-01T00:00:00Z",
			}),
			cached("136.0", "beta.26", {
				sha256: SHA_A,
				created_at: "2026-01-01T00:00:00Z",
			}),
			cached("135.0", "beta.25"),
		],
	};
}

function cache(): RepoCache {
	return {
		repos: [
			officialRepo(),
			{
				name: "CoryKing",
				repo: "coryking/camoufox",
				versions: [cached("142.0.1", "fork.26")],
			},
		],
	};
}

describe("catalog helpers", () => {
	test("latestPerBuild keeps the newest asset per version-build, newest first", async () => {
		const { latestPerBuild, versionBuild } = await import(
			"../src/multiversion"
		);
		const latest = latestPerBuild(officialRepo().versions);
		expect(latest.map(versionBuild)).toEqual([
			"137.0-beta.27",
			"136.0-beta.26",
			"135.0-beta.25",
		]);
		expect(latest[1].sha256).toBe(SHA_B);
	});

	test("resolveSpec matches version-build and version-build-sha8", async () => {
		const { resolveSpec } = await import("../src/multiversion");
		const repo = officialRepo();
		// Following the build resolves to the latest dated asset, without a sha pin
		const followed = resolveSpec(repo, "136.0-beta.26");
		expect(followed.verData?.sha256).toBe(SHA_B);
		expect(followed.sha).toBeUndefined();
		// A sha8 suffix pins the exact asset
		expect(
			resolveSpec(repo, `136.0-beta.26-${SHA_A.slice(0, 8)}`),
		).toMatchObject({
			verData: { sha256: SHA_A },
			sha: SHA_A,
		});
		expect(resolveSpec(repo, "1.0-beta.1")).toEqual({});
	});

	test("resolveFetchTarget follows the default channel", async () => {
		const { resolveFetchTarget } = await import("../src/multiversion");
		const target = resolveFetchTarget(cache(), {});
		expect(target.display).toBe("official/stable");
		expect(target.verData?.build).toBe("beta.26");
		expect(target.error).toBeUndefined();
	});

	test("resolveFetchTarget follows a prerelease channel and pins", async () => {
		const { resolveFetchTarget } = await import("../src/multiversion");
		expect(
			resolveFetchTarget(cache(), { channel: "official/prerelease" }).verData
				?.build,
		).toBe("beta.27");
		expect(
			resolveFetchTarget(cache(), {
				channel: "official/stable",
				pinned: "135.0-beta.25",
			}).verData?.build,
		).toBe("beta.25");
		expect(
			resolveFetchTarget(cache(), {
				channel: "official/stable",
				pinned: "136.0-beta.26",
				pinned_sha: SHA_A,
			}).verData?.sha256,
		).toBe(SHA_A);
		const missing = resolveFetchTarget(cache(), {
			channel: "official/stable",
			pinned: "1.0-beta.1",
		});
		expect(missing.verData).toBeUndefined();
		expect(missing.error).toContain("official/stable/1.0-beta.1");
	});

	test("resolveFetchTarget accepts the Python CLI specifier forms", async () => {
		const { resolveFetchTarget } = await import("../src/multiversion");
		const c = cache();
		const forms = [
			"135.0-beta.25",
			"v135.0-beta.25",
			"official/135.0-beta.25",
			"Official/stable/135.0-beta.25",
		];
		for (const spec of forms) {
			const t = resolveFetchTarget(c, { pinned: "should-be-ignored" }, spec);
			expect(t.verData?.build, spec).toBe("beta.25");
			expect(t.repoData?.name, spec).toBe("Official");
		}
		expect(
			resolveFetchTarget(c, {}, "coryking/stable/142.0.1-fork.26").verData
				?.build,
		).toBe("fork.26");
		expect(resolveFetchTarget(c, {}, "a/b/c/d").error).toContain("Format:");
		expect(resolveFetchTarget(c, {}, "nope/1.0-beta.1").error).toContain(
			"not found in cache",
		);
	});
});

describe("installed versions", () => {
	let installDir: string;

	beforeEach(() => {
		installDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-mv-"));
		vi.stubEnv("CAMOUFOX_INSTALL_DIR", installDir);
		vi.resetModules();
		vi.stubGlobal("console", { ...console, log: vi.fn() });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
		fs.rmSync(installDir, { recursive: true, force: true });
	});

	function fakeInstall(
		repo: string,
		folder: string,
		meta: Record<string, unknown>,
	): string {
		const dir = path.join(installDir, "browsers", repo, folder);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify(meta));
		return dir;
	}

	test("listInstalled reads version.json metadata and marks the active one", async () => {
		fakeInstall("official", "135.0-beta.25", {
			version: "135.0",
			build: "beta.25",
			prerelease: false,
		});
		const newer = fakeInstall(
			"official",
			`136.0-beta.26-${SHA_B.slice(0, 8)}`,
			{
				version: "136.0",
				build: "beta.26",
				prerelease: false,
				sha256: SHA_B,
				created_at: "2026-02-01T00:00:00Z",
			},
		);
		fakeInstall("coryking", "142.0.1-fork.26", {
			version: "142.0.1",
			build: "fork.26",
			prerelease: true,
		});
		// folders without version.json are ignored
		fs.mkdirSync(path.join(installDir, "browsers", "official", "junk"));

		const mv = await import("../src/multiversion");
		mv.setActive("browsers/official/136.0-beta.26-bbbbbbbb");

		const installed = mv.listInstalled();
		expect(installed.map((v) => v.channelPath)).toEqual([
			"official/stable/136.0-beta.26",
			"official/stable/135.0-beta.25",
			"coryking/prerelease/142.0.1-fork.26",
		]);
		expect(installed[0].isActive).toBe(true);
		expect(installed[0].relativePath).toBe(
			"browsers/official/136.0-beta.26-bbbbbbbb",
		);
		expect(mv.getActivePath()).toBe(newer);
		expect(mv.installedLabel(installed[0])).toBe("Feb 1");
		expect(mv.installedLabel(installed[1])).toBe("");
	});

	test("getActivePath auto-selects the newest install without a channel or pin", async () => {
		fakeInstall("official", "135.0-beta.25", {
			version: "135.0",
			build: "beta.25",
		});
		const newer = fakeInstall("official", "136.0-beta.26", {
			version: "136.0",
			build: "beta.26",
		});
		const mv = await import("../src/multiversion");
		expect(mv.getActivePath()).toBe(newer);
		expect(mv.loadConfig().active_version).toBe(
			"browsers/official/136.0-beta.26",
		);

		// ...but not when the user follows a channel: the fetch decides.
		fs.rmSync(newer, { recursive: true });
		mv.saveConfig({ channel: "official/stable" });
		expect(mv.getActivePath()).toBeNull();
	});

	test("findInstalled accepts every specifier shape", async () => {
		fakeInstall("official", "135.0-beta.25", {
			version: "135.0",
			build: "beta.25",
			prerelease: false,
		});
		fakeInstall("official", "137.0-beta.27", {
			version: "137.0",
			build: "beta.27",
			prerelease: true,
		});
		const { findInstalled } = await import("../src/multiversion");
		for (const spec of [
			"official/stable/135.0-beta.25",
			"browsers/official/135.0-beta.25",
			"beta.25",
			"135.0-beta.25",
			"official/135.0-beta.25",
			"official/stable",
		]) {
			expect(findInstalled(spec)?.version.fullString, spec).toBe(
				"135.0-beta.25",
			);
		}
		expect(findInstalled("official/prerelease")?.version.build).toBe("beta.27");
		expect(findInstalled("coryking/stable")).toBeUndefined();
	});

	test("findInstall matches sha8 folders and legacy folders", async () => {
		fakeInstall("official", `136.0-beta.26-${SHA_A.slice(0, 8)}`, {
			version: "136.0",
			build: "beta.26",
			sha256: SHA_A,
		});
		fakeInstall("official", "135.0-beta.25", {
			version: "135.0",
			build: "beta.25",
		});
		const { findInstall, listInstalled } = await import("../src/multiversion");
		const installed = listInstalled();
		expect(findInstall("136.0-beta.26", SHA_A, installed, 2)?.sha256).toBe(
			SHA_A,
		);
		expect(findInstall("136.0-beta.26", SHA_B, installed, 2)).toBeUndefined();
		// a legacy folder without sha counts only when the build is unambiguous
		expect(
			findInstall("135.0-beta.25", SHA_A, installed, 1)?.version.build,
		).toBe("beta.25");
		expect(findInstall("135.0-beta.25", SHA_A, installed, 2)).toBeUndefined();
	});

	test("removeVersion prunes empty repo folders and moves the active version", async () => {
		const a = fakeInstall("official", "135.0-beta.25", {
			version: "135.0",
			build: "beta.25",
		});
		const b = fakeInstall("coryking", "142.0.1-fork.26", {
			version: "142.0.1",
			build: "fork.26",
		});
		const mv = await import("../src/multiversion");
		mv.setActive("browsers/coryking/142.0.1-fork.26");

		expect(mv.removeVersion(b)).toBe(true);
		expect(fs.existsSync(path.join(installDir, "browsers", "coryking"))).toBe(
			false,
		);
		expect(mv.loadConfig().active_version).toBe(
			"browsers/official/135.0-beta.25",
		);

		expect(mv.removeVersion(a)).toBe(true);
		expect(fs.existsSync(path.join(installDir, "browsers"))).toBe(false);
		expect(mv.loadConfig().active_version).toBeNull();
		expect(mv.removeVersion(a)).toBe(false);
	});

	test("syncRepos writes the cache and keeps stale data for a failing repo", async () => {
		const mv = await import("../src/multiversion");
		mv.saveRepoCache({
			repos: [
				{
					name: "CoryKing",
					repo: "coryking/camoufox",
					versions: [cached("142.0.1", "fork.26")],
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("daijro/camoufox")) {
					return {
						ok: true,
						json: async () => [
							{
								prerelease: false,
								assets: [
									{
										name: "camoufox-136.0-beta.26-lin.x86_64.zip",
										browser_download_url: "https://example.test/a.zip",
										digest: `sha256:${SHA_A}`,
										created_at: "2026-01-01T00:00:00Z",
									},
								],
							},
						],
					};
				}
				return { ok: false, status: 500 };
			}),
		);
		const result = await mv.syncRepos({
			spoofOs: "lin",
			spoofArch: "x86_64",
			quiet: true,
		});
		expect(result.repos.map((r) => r.name)).toEqual(["Official", "CoryKing"]);
		expect(result.repos[0].versions).toEqual([
			expect.objectContaining({
				version: "136.0",
				build: "beta.26",
				is_prerelease: false,
				sha256: SHA_A,
			}),
		]);
		expect(result.repos[1].versions[0].build).toBe("fork.26");
		expect(mv.loadRepoCache()).toEqual(result);
		vi.unstubAllGlobals();
	});
});
