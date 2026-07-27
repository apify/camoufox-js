import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getPath } from "../src/pkgman";
import { getAsBooleanFromENV, launchOptions } from "../src/utils";

describe("getAsBooleanFromENV", () => {
	afterEach(() => {
		// Clean up env vars
		delete process.env.TEST_BOOL_VAR;
	});

	test("returns true for truthy env value", () => {
		process.env.TEST_BOOL_VAR = "1";
		expect(getAsBooleanFromENV("TEST_BOOL_VAR")).toBe(true);
	});

	test("returns true for non-empty string", () => {
		process.env.TEST_BOOL_VAR = "yes";
		expect(getAsBooleanFromENV("TEST_BOOL_VAR")).toBe(true);
	});

	test("returns false for '0'", () => {
		process.env.TEST_BOOL_VAR = "0";
		expect(getAsBooleanFromENV("TEST_BOOL_VAR")).toBe(false);
	});

	test("returns false for 'false'", () => {
		process.env.TEST_BOOL_VAR = "false";
		expect(getAsBooleanFromENV("TEST_BOOL_VAR")).toBe(false);
	});

	test("returns default value when env var not set", () => {
		expect(getAsBooleanFromENV("TEST_BOOL_VAR", true)).toBe(true);
		expect(getAsBooleanFromENV("TEST_BOOL_VAR", false)).toBe(false);
	});

	test("returns false when env var not set and no default", () => {
		expect(getAsBooleanFromENV("TEST_BOOL_VAR")).toBe(false);
	});
});

describe("launchOptions seeding", () => {
	const readConfig = (env: Record<string, unknown>) =>
		JSON.parse(
			Object.keys(env)
				.filter((k) => k.startsWith("CAMOU_CONFIG_"))
				.sort()
				.map((k) => env[k])
				.join(""),
		);

	// Browsers older than Camoufox 2.0 have no audio:seed / canvas:seed property,
	// and validateConfig rejects anything missing from properties.json.
	const legacyBrowserDir = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-legacy-"));
		const properties = JSON.parse(
			fs.readFileSync(getPath("properties.json"), "utf-8"),
		).filter(
			(p: { property: string }) =>
				p.property !== "audio:seed" && p.property !== "canvas:seed",
		);
		fs.writeFileSync(
			path.join(dir, "properties.json"),
			JSON.stringify(properties),
		);
		return path.join(dir, "camoufox-bin");
	};

	test("seeds all three properties on a supported browser", async () => {
		const { env } = await launchOptions({ headless: true });
		expect(Object.keys(readConfig(env))).toEqual(
			expect.arrayContaining([
				"fonts:spacing_seed",
				"audio:seed",
				"canvas:seed",
			]),
		);
	});

	test("skips seeds the installed browser does not support", async () => {
		const { env } = await launchOptions({
			headless: true,
			executable_path: legacyBrowserDir(),
		});
		const keys = Object.keys(readConfig(env));
		expect(keys).toContain("fonts:spacing_seed");
		expect(keys).not.toContain("audio:seed");
		expect(keys).not.toContain("canvas:seed");
	});

	test("still rejects an explicitly passed unsupported seed", async () => {
		await expect(
			launchOptions({
				headless: true,
				executable_path: legacyBrowserDir(),
				config: { "audio:seed": 123 },
			}),
		).rejects.toThrow("Unknown property audio:seed in config");
	});
});
