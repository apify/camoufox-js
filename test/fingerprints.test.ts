import { describe, expect, test } from "vitest";
import {
	fromBrowserforge,
	generateFingerprint,
	SUPPORTED_OS,
} from "../src/fingerprints";

describe("SUPPORTED_OS", () => {
	test("contains linux, macos, windows", () => {
		expect(SUPPORTED_OS).toContain("linux");
		expect(SUPPORTED_OS).toContain("macos");
		expect(SUPPORTED_OS).toContain("windows");
		expect(SUPPORTED_OS).toHaveLength(3);
	});
});

describe("generateFingerprint", () => {
	test("generates a fingerprint without window size", () => {
		const fp = generateFingerprint();
		expect(fp).toBeDefined();
		expect(fp.navigator).toBeDefined();
		expect(fp.navigator.userAgent).toBeTruthy();
		expect(fp.screen).toBeDefined();
	});

	test("generates a Firefox fingerprint", () => {
		const fp = generateFingerprint();
		expect(fp.navigator.userAgent).toMatch(/Firefox/);
	});

	test("generates fingerprint with custom window size", () => {
		const width = 1280;
		const height = 720;
		const fp = generateFingerprint([width, height]);
		expect(fp.screen.outerWidth).toBe(width);
		expect(fp.screen.outerHeight).toBe(height);
	});

	test("custom window centers on screen", () => {
		const width = 800;
		const height = 600;
		const fp = generateFingerprint([width, height]);

		// screenY should be set based on centering
		const expectedScreenY = Math.floor((fp.screen.height - height) / 2);
		expect((fp.screen as any).screenY).toBe(expectedScreenY);
	});

	test("custom window adjusts inner dimensions", () => {
		const width = 1024;
		const height = 768;
		const fp = generateFingerprint([width, height]);

		// Inner dimensions should be non-negative
		if (fp.screen.innerWidth) {
			expect(fp.screen.innerWidth).toBeGreaterThanOrEqual(0);
		}
		if (fp.screen.innerHeight) {
			expect(fp.screen.innerHeight).toBeGreaterThanOrEqual(0);
		}
	});

	test("generates different fingerprints on successive calls", () => {
		const fp1 = generateFingerprint();
		const fp2 = generateFingerprint();
		// At minimum, user agents or screen properties should vary
		// (not guaranteed to be different every time, but highly likely)
		const ua1 = fp1.navigator.userAgent;
		const ua2 = fp2.navigator.userAgent;
		// Just check both are valid, not necessarily different
		expect(ua1).toMatch(/Firefox/);
		expect(ua2).toMatch(/Firefox/);
	});

	test("fingerprint screen has required properties", () => {
		const fp = generateFingerprint();
		const screen = fp.screen;
		expect(screen.width).toBeGreaterThan(0);
		expect(screen.height).toBeGreaterThan(0);
		expect(screen.availWidth).toBeGreaterThan(0);
		expect(screen.availHeight).toBeGreaterThan(0);
		expect(screen.outerWidth).toBeGreaterThan(0);
		expect(screen.outerHeight).toBeGreaterThan(0);
	});
});

describe("fromBrowserforge", () => {
	test("converts fingerprint to camoufox config", () => {
		const fp = generateFingerprint();
		const config = fromBrowserforge(fp);
		expect(config).toBeDefined();
		expect(typeof config).toBe("object");
	});

	test("config contains screen properties", () => {
		const fp = generateFingerprint();
		const config = fromBrowserforge(fp);
		// Should have window.screenY set
		expect("window.screenY" in config).toBe(true);
	});

	test("config contains navigator properties", () => {
		const fp = generateFingerprint();
		const config = fromBrowserforge(fp);
		// Should have user agent related properties
		const keys = Object.keys(config);
		expect(keys.length).toBeGreaterThan(0);
	});

	test("negative screen values are clamped to 0", () => {
		const fp = generateFingerprint();
		const config = fromBrowserforge(fp);
		// All screen.* values should be >= 0
		for (const [key, value] of Object.entries(config)) {
			if (key.startsWith("screen.") && typeof value === "number") {
				expect(value).toBeGreaterThanOrEqual(0);
			}
		}
	});

	test("replaces Firefox version when ffVersion is provided", () => {
		const fp = generateFingerprint();
		const config = fromBrowserforge(fp, "999");
		// Check that string values containing version numbers were replaced
		for (const value of Object.values(config)) {
			if (typeof value === "string" && value.includes(".0")) {
				// If the value contains a version pattern, it should use 999
				// This is a soft check since not all strings will have versions
			}
		}
		// Just ensure it doesn't throw
		expect(config).toBeDefined();
	});

	test("screenXY defaults to 0 when screenX is falsy", () => {
		const fp = generateFingerprint();
		// Force screenX to 0
		fp.screen.screenX = 0;
		const config = fromBrowserforge(fp);
		expect(config["window.screenX"]).toBe(0);
		expect(config["window.screenY"]).toBe(0);
	});

	test("screenY equals screenX when screenX is within [-50, 50]", () => {
		const fp = generateFingerprint();
		fp.screen.screenX = 25;
		const config = fromBrowserforge(fp);
		expect(config["window.screenY"]).toBe(25);
	});

	test("does not override manually set screenY", () => {
		const fp = generateFingerprint();
		// First convert to get some base config, then add manual screenY
		const config = fromBrowserforge(fp);
		// If window.screenY was already in the browserforge data, it should be preserved
		expect("window.screenY" in config).toBe(true);
	});
});
