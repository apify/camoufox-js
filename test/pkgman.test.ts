import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

	test("CAMOUFOX_INSTALL_DIR overrides the install location", async () => {
		const target = path.join("custom", "camoufox-install");
		vi.stubEnv("CAMOUFOX_INSTALL_DIR", target);
		vi.resetModules();
		const { INSTALL_DIR } = await import("../src/pkgman");
		expect(INSTALL_DIR).toBe(path.resolve(target));
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

// A fetch that writes a few bytes and completes cleanly.
function succeedingFetch() {
	return vi.fn(async () => ({
		ok: true,
		headers: { get: () => "0" },
		body: (async function* () {
			yield new Uint8Array([1, 2, 3]);
		})(),
	}));
}

describe("CamoufoxFetcher.install cleanup", () => {
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

	// Staging dirs install() creates: <tmpdir>/camoufox-<6 random chars>.
	function stagingDirs(): string[] {
		return fs
			.readdirSync(tmp)
			.filter((n) => /^camoufox-[A-Za-z0-9]{6}$/.test(n));
	}

	async function installWith(fetchImpl: ReturnType<typeof vi.fn>) {
		const { CamoufoxFetcher } = await import("../src/pkgman");
		const fetcher = new CamoufoxFetcher();
		// Skip the release lookup; just hand install() a URL to download.
		vi.spyOn(fetcher, "init").mockImplementation(async () => {
			(fetcher as unknown as { _url: string })._url =
				"https://example.test/camoufox.zip";
		});
		// Don't extract the placeholder zip or write a version file.
		vi.spyOn(fetcher, "extractZip").mockResolvedValue(undefined);
		vi.spyOn(fetcher, "setVersion").mockImplementation(() => {});
		vi.stubGlobal("fetch", fetchImpl);
		vi.stubGlobal("console", { ...console, error: vi.fn(), log: vi.fn() });
		return fetcher;
	}

	test("removes the staging dir when the download fails", async () => {
		const fetcher = await installWith(failingFetch());
		// The original download error must survive, and no staging dir is left.
		await expect(fetcher.install()).rejects.toThrow("connection reset");
		expect(stagingDirs()).toEqual([]);
	});

	test("removes the staging dir after a successful install", async () => {
		const fetcher = await installWith(succeedingFetch());
		// A successful install must resolve (not throw) and leave no staging dir.
		await expect(fetcher.install()).resolves.toBeUndefined();
		expect(stagingDirs()).toEqual([]);
	});
});
