import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// INSTALL_DIR is a module-level constant, so each case re-imports the module
// after adjusting the environment.
describe("INSTALL_DIR", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	test("defaults to the user cache dir", async () => {
		vi.stubEnv("CAMOUFOX_INSTALL_DIR", "");
		vi.resetModules();
		const { INSTALL_DIR } = await import("../src/pkgman");
		expect(INSTALL_DIR.toString()).toContain("camoufox");
		expect(path.isAbsolute(INSTALL_DIR.toString())).toBe(true);
	});

	test.skipIf(process.platform !== "linux")(
		"honors an absolute XDG_CACHE_HOME on Linux",
		async () => {
			vi.stubEnv("CAMOUFOX_INSTALL_DIR", "");
			vi.stubEnv("XDG_CACHE_HOME", "/xdg-cache");
			vi.resetModules();
			const { INSTALL_DIR } = await import("../src/pkgman");
			expect(INSTALL_DIR).toBe(path.join("/xdg-cache", "camoufox"));
		},
	);

	test.skipIf(process.platform !== "linux")(
		"ignores a relative XDG_CACHE_HOME",
		async () => {
			vi.stubEnv("CAMOUFOX_INSTALL_DIR", "");
			vi.stubEnv("XDG_CACHE_HOME", "relative/cache");
			vi.resetModules();
			const { INSTALL_DIR } = await import("../src/pkgman");
			expect(INSTALL_DIR).toBe(path.join(os.homedir(), ".cache", "camoufox"));
		},
	);

	test("CAMOUFOX_INSTALL_DIR overrides the install location", async () => {
		const target = path.join("custom", "camoufox-install");
		vi.stubEnv("CAMOUFOX_INSTALL_DIR", target);
		vi.resetModules();
		const { INSTALL_DIR } = await import("../src/pkgman");
		expect(INSTALL_DIR).toBe(path.resolve(target));
	});
});

describe("Version", () => {
	test("orders builds numerically with alpha < beta", async () => {
		const { Version } = await import("../src/pkgman");
		const order = ["alpha.1", "alpha.26", "beta.19", "beta.25", "beta.30"];
		for (let i = 1; i < order.length; i++) {
			expect(new Version(order[i - 1]).lessThan(new Version(order[i]))).toBe(
				true,
			);
		}
		expect(new Version("beta.25").equals(new Version("beta.25"))).toBe(true);
		expect(new Version("alpha.3").isAlpha).toBe(true);
		expect(new Version("beta.3").isAlpha).toBe(false);
		expect(new Version("beta.25", "135.0").fullString).toBe("135.0-beta.25");
	});

	test("reads build, legacy release and tag keys from version.json", async () => {
		const { Version } = await import("../src/pkgman");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-ver-"));
		try {
			for (const key of ["build", "release", "tag"]) {
				fs.writeFileSync(
					path.join(tmp, "version.json"),
					JSON.stringify({ version: "135.0", [key]: "beta.25" }),
				);
				expect(Version.fromPath(tmp).fullString).toBe("135.0-beta.25");
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("RepoConfig", () => {
	test("builds an anchored asset pattern with named groups", async () => {
		const { RepoConfig } = await import("../src/pkgman");
		const repo = RepoConfig.getDefault();
		const pattern = repo.buildPattern("lin", "x86_64");
		const m = pattern.exec("camoufox-135.0.1-beta.24-lin.x86_64.zip");
		expect(m?.groups).toMatchObject({
			name: "camoufox",
			version: "135.0.1",
			build: "beta.24",
		});
		expect(pattern.test("camoufox-135.0.1-beta.24-win.x86_64.zip")).toBe(false);
		expect(pattern.test("camoufox-135.0.1-beta.24-lin.arm64.zip")).toBe(false);
	});

	test("applies channel bounds from the repo definition", async () => {
		const { RepoConfig, Version } = await import("../src/pkgman");
		const official = RepoConfig.findByName("official")!;
		expect(official.repos).toEqual(["daijro/camoufox", "camoufox/camoufox"]);
		// stable: beta.19 <= build <= 1
		expect(official.isVersionSupported(new Version("beta.18"), false)).toBe(
			false,
		);
		expect(official.isVersionSupported(new Version("beta.19"), false)).toBe(
			true,
		);
		// prerelease channel has no bounds
		expect(official.isVersionSupported(new Version("alpha.1"), true)).toBe(
			true,
		);
		// repos without bounds accept everything
		const cory = RepoConfig.findByName("CoryKing")!;
		expect(cory.isVersionSupported(new Version("fork.1"), false)).toBe(true);
	});
});

describe("GitHubDownloader.getAsset", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("skips prerelease and draft releases", async () => {
		const { GitHubDownloader } = await import("../src/pkgman");
		const downloader = new GitHubDownloader("example/repo");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => [
					{ prerelease: true, assets: [{ browser_download_url: "bad-pre" }] },
					{ draft: true, assets: [{ browser_download_url: "bad-draft" }] },
					{ assets: [{ browser_download_url: "good" }] },
				],
			})),
		);
		await expect(downloader.getAsset()).resolves.toBe("good");
	});

	test("falls back to the next repo when the first fails", async () => {
		const { GitHubDownloader } = await import("../src/pkgman");
		const downloader = new GitHubDownloader(["bad/repo", "good/repo"]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("bad/repo")) return { ok: false, status: 500 };
				return {
					ok: true,
					json: async () => [{ assets: [{ browser_download_url: "good" }] }],
				};
			}),
		);
		await expect(downloader.getAsset({ retries: 1 })).resolves.toBe("good");
		expect(downloader.githubRepo).toBe("good/repo");
	});
});

function releasesFixture() {
	const asset = (
		name: string,
		extra: Record<string, unknown> = {},
	): Record<string, unknown> => ({
		name,
		browser_download_url: `https://example.test/${name}`,
		id: name.length,
		size: 100,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...extra,
	});
	return [
		{
			prerelease: false,
			assets: [
				asset("camoufox-136.0-beta.26-lin.x86_64.zip", {
					digest: "sha256:abcdef0123456789",
				}),
				asset("camoufox-136.0-beta.26-win.x86_64.zip"),
			],
		},
		{
			prerelease: true,
			assets: [asset("camoufox-137.0-beta.27-lin.x86_64.zip")],
		},
		{
			// alpha builds count as prerelease even on a stable GitHub release
			prerelease: false,
			assets: [asset("camoufox-140.0-alpha.3-lin.x86_64.zip")],
		},
		{
			// below the stable floor (beta.19) of the official repo
			prerelease: false,
			assets: [asset("camoufox-130.0-beta.18-lin.x86_64.zip")],
		},
		{ draft: true, assets: [asset("camoufox-999.0-beta.99-lin.x86_64.zip")] },
	];
}

describe("listAvailableVersions", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("filters by platform, channel bounds and marks prereleases", async () => {
		const { listAvailableVersions, RepoConfig } = await import("../src/pkgman");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => releasesFixture() })),
		);
		const versions = await listAvailableVersions({
			repoConfig: RepoConfig.getDefault(),
			spoofOs: "lin",
			spoofArch: "x86_64",
		});
		// Sorted by build: alpha.* sorts below beta.*, like the Python library.
		expect(versions.map((v) => v.version.fullString)).toEqual([
			"137.0-beta.27",
			"136.0-beta.26",
			"140.0-alpha.3",
		]);
		expect(versions.map((v) => v.isPrerelease)).toEqual([true, false, true]);
		expect(versions[1].sha256).toBe("abcdef0123456789");

		const stable = await listAvailableVersions({
			repoConfig: RepoConfig.getDefault(),
			includePrerelease: false,
			spoofOs: "lin",
			spoofArch: "x86_64",
		});
		expect(stable.map((v) => v.version.fullString)).toEqual(["136.0-beta.26"]);
	});
});

// A fetch that writes a few bytes then errors mid-stream, like a dropped connection.
function failingFetch() {
	return vi.fn(async () => ({
		ok: true,
		headers: { get: () => "0" },
		body: (async function* () {
			yield new Uint8Array([1, 2, 3]);
			throw new Error("connection reset");
		})(),
	}));
}

// A fetch that serves a small real zip and completes cleanly.
function zipBytes(): Uint8Array {
	const zip = new AdmZip();
	zip.addFile("camoufox", Buffer.from("binary"));
	return new Uint8Array(zip.toBuffer());
}

function succeedingFetch(bytes: Uint8Array = zipBytes()) {
	return vi.fn(async () => ({
		ok: true,
		headers: { get: () => "0" },
		body: (async function* () {
			yield bytes;
		})(),
	}));
}

describe("CamoufoxFetcher.install", () => {
	let tmp: string;
	let installDir: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-pkgtest-"));
		installDir = path.join(tmp, "install");
		fs.mkdirSync(installDir);
		// Isolate both the install location and the staging tmpdir into our own dir.
		// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows - stub all three.
		vi.stubEnv("CAMOUFOX_INSTALL_DIR", installDir);
		vi.stubEnv("TMPDIR", tmp);
		vi.stubEnv("TEMP", tmp);
		vi.stubEnv("TMP", tmp);
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.resetModules();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// Dirs install() creates: <tmpdir>/camoufox-<6 random chars> and
	// <version dir>.staging-<6 random chars> next to the version folder.
	function stagingDirs(): string[] {
		const found: string[] = [];
		const walk = (dir: string) => {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (/^camoufox-[A-Za-z0-9]{6}$|\.staging-/.test(entry.name)) {
					found.push(entry.name);
				} else {
					walk(path.join(dir, entry.name));
				}
			}
		};
		walk(tmp);
		return found;
	}

	async function installWith(
		fetchImpl: ReturnType<typeof vi.fn>,
		{ sha256 }: { sha256?: string } = {},
	) {
		const { CamoufoxFetcher, Version } = await import("../src/pkgman");
		const fetcher = new CamoufoxFetcher();
		// Skip the release lookup; hand install() a URL and version directly.
		fetcher.selectVersion({
			version: new Version("beta.1", "1.0"),
			url: "https://example.test/camoufox.zip",
			isPrerelease: false,
			sha256,
			assetCreatedAt: "2026-01-02T03:04:05Z",
		});
		vi.stubGlobal("fetch", fetchImpl);
		vi.stubGlobal("console", { ...console, error: vi.fn(), log: vi.fn() });
		return fetcher;
	}

	const versionDir = () =>
		path.join(installDir, "browsers", "official", "1.0-beta.1");

	test("installs into browsers/<repo>/<version>-<build> and activates it", async () => {
		const fetcher = await installWith(succeedingFetch());
		await expect(fetcher.install()).resolves.toBe(true);
		expect(stagingDirs()).toEqual([]);
		expect(fs.readdirSync(versionDir()).sort()).toEqual([
			"camoufox",
			"version.json",
		]);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(versionDir(), "version.json"), "utf8"),
			),
		).toMatchObject({
			version: "1.0",
			build: "beta.1",
			prerelease: false,
			created_at: "2026-01-02T03:04:05Z",
		});
		const config = JSON.parse(
			fs.readFileSync(path.join(installDir, "config.json"), "utf8"),
		);
		expect(config.active_version).toBe("browsers/official/1.0-beta.1");
		expect(fs.existsSync(path.join(installDir, ".0.5_FLAG"))).toBe(true);

		const { camoufoxPath, installedVerStr } = await import("../src/pkgman");
		expect(installedVerStr()).toBe("1.0-beta.1");
		expect(camoufoxPath()).toBe(versionDir());
	});

	test("suffixes the folder with sha8 and verifies the download", async () => {
		const bytes = zipBytes();
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const fetcher = await installWith(succeedingFetch(bytes), { sha256 });
		await expect(fetcher.install()).resolves.toBe(true);
		expect(
			fs.existsSync(
				path.join(
					installDir,
					"browsers",
					"official",
					`1.0-beta.1-${sha256.slice(0, 8)}`,
					"version.json",
				),
			),
		).toBe(true);
	});

	test("rejects a download whose sha256 does not match", async () => {
		const fetcher = await installWith(succeedingFetch(), {
			sha256: "0".repeat(64),
		});
		await expect(fetcher.install()).rejects.toThrow("Checksum mismatch");
		expect(stagingDirs()).toEqual([]);
		expect(fs.existsSync(versionDir())).toBe(false);
		expect(fs.existsSync(path.join(installDir, "config.json"))).toBe(false);
	});

	test("keeps the previous install when the download fails", async () => {
		// An older version is installed and active.
		const old = path.join(installDir, "browsers", "official", "0.9-beta.0");
		fs.mkdirSync(old, { recursive: true });
		fs.writeFileSync(
			path.join(old, "version.json"),
			JSON.stringify({ version: "0.9", build: "beta.0" }),
		);
		const fetcher = await installWith(failingFetch());
		// The original download error must survive, and no staging dir is left.
		await expect(fetcher.install()).rejects.toThrow("connection reset");
		expect(stagingDirs()).toEqual([]);
		expect(fs.existsSync(path.join(old, "version.json"))).toBe(true);
		expect(fs.existsSync(versionDir())).toBe(false);
	});

	test("reports an already installed version unless replace is set", async () => {
		const fetcher = await installWith(succeedingFetch());
		await expect(fetcher.install()).resolves.toBe(true);
		const marker = path.join(versionDir(), "old-file");
		fs.writeFileSync(marker, "");

		await expect(fetcher.install()).resolves.toBe(false);
		expect(fs.existsSync(marker)).toBe(true);

		// A stale active_version (folder removed by hand) is repointed at it.
		const configFile = path.join(installDir, "config.json");
		fs.writeFileSync(
			configFile,
			JSON.stringify({ active_version: "browsers/official/gone" }),
		);
		await expect(fetcher.install()).resolves.toBe(false);
		expect(JSON.parse(fs.readFileSync(configFile, "utf8")).active_version).toBe(
			"browsers/official/1.0-beta.1",
		);

		await expect(fetcher.install({ replace: true })).resolves.toBe(true);
		expect(fs.existsSync(marker)).toBe(false);
		expect(stagingDirs()).toEqual([]);
	});

	test.skipIf(process.platform === "win32")(
		"installs through a symlinked install dir and keeps the link",
		async () => {
			const target = path.join(tmp, "target");
			fs.mkdirSync(target);
			fs.rmSync(installDir, { recursive: true });
			fs.symlinkSync(target, installDir);
			const fetcher = await installWith(succeedingFetch());
			await expect(fetcher.install()).resolves.toBe(true);
			expect(stagingDirs()).toEqual([]);
			expect(fs.lstatSync(installDir).isSymbolicLink()).toBe(true);
			expect(
				fs
					.readdirSync(path.join(target, "browsers", "official", "1.0-beta.1"))
					.sort(),
			).toEqual(["camoufox", "version.json"]);
		},
	);
});

describe("cleanOldData", () => {
	let installDir: string;

	beforeEach(() => {
		installDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfx-legacy-"));
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

	test("removes a pre-multiversion flat install", async () => {
		fs.writeFileSync(
			path.join(installDir, "version.json"),
			JSON.stringify({ version: "1.0", release: "beta.1" }),
		);
		fs.writeFileSync(path.join(installDir, "camoufox-bin"), "");
		const { cleanOldData } = await import("../src/pkgman");
		expect(cleanOldData()).toBe(true);
		expect(fs.existsSync(installDir)).toBe(false);
	});

	test("leaves a versioned install alone", async () => {
		fs.writeFileSync(path.join(installDir, ".0.5_FLAG"), "");
		fs.mkdirSync(path.join(installDir, "browsers"));
		const { cleanOldData } = await import("../src/pkgman");
		expect(cleanOldData()).toBe(false);
		expect(fs.existsSync(path.join(installDir, "browsers"))).toBe(true);
	});

	test("leaves config and repo cache written before any install alone", async () => {
		const { saveConfig } = await import("../src/multiversion");
		saveConfig({ channel: "official/prerelease" });
		const { cleanOldData } = await import("../src/pkgman");
		expect(cleanOldData()).toBe(false);
		expect(fs.existsSync(path.join(installDir, "config.json"))).toBe(true);
	});
});
