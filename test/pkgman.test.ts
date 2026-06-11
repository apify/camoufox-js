import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// INSTALL_DIR is a module-level constant, so each case re-imports the module
// after adjusting the environment.
describe("INSTALL_DIR", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	test("defaults to the user cache dir", async () => {
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
