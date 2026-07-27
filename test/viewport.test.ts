import { describe, expect, test } from "vitest";
import { Camoufox } from "../src";
import { attachNoViewportDefault, spoofsWindowDimensions } from "../src/utils";

describe("spoofsWindowDimensions", () => {
	test("detects a spoofed dimension across config chunks", () => {
		expect(
			spoofsWindowDimensions({
				env: {
					CAMOU_CONFIG_2: 'erWidth":1280}',
					CAMOU_CONFIG_1: '{"window.out',
				},
			}),
		).toBe(true);
	});

	test("is false without window dimensions in the config", () => {
		expect(
			spoofsWindowDimensions({
				env: { CAMOU_CONFIG_1: '{"navigator.platform":"Win32"}' },
			}),
		).toBe(false);
	});

	test("is false without a config", () => {
		expect(spoofsWindowDimensions({})).toBe(false);
	});
});

describe("attachNoViewportDefault", () => {
	const stub = () => {
		const calls: any[] = [];
		return {
			calls,
			newPage: (options?: any) => calls.push(options),
			newContext: (options?: any) => calls.push(options),
		};
	};

	test("defaults newPage/newContext to no viewport", () => {
		const target = attachNoViewportDefault(stub());
		target.newPage();
		target.newContext({ locale: "en-US" });
		expect(target.calls).toEqual([
			{ viewport: null },
			{ locale: "en-US", viewport: null },
		]);
	});

	test("keeps an explicit viewport", () => {
		const target = attachNoViewportDefault(stub());
		target.newPage({ viewport: { width: 800, height: 600 } });
		expect(target.calls).toEqual([{ viewport: { width: 800, height: 600 } }]);
	});
});

describe("window size", () => {
	test("page reports the spoofed window size, not Playwright's default", async () => {
		const browser = await Camoufox({
			os: "windows",
			headless: true,
			window: [1650, 1080],
		});

		try {
			const page = await browser.newPage();
			const size = await page.evaluate(() => ({
				width: window.innerWidth,
				height: window.innerHeight,
			}));
			expect(size.width).toBe(1650);
			expect(size.height).toBeLessThanOrEqual(1080);
			expect(size).not.toEqual({ width: 1280, height: 720 });
		} finally {
			await browser.close();
		}
	}, 30e3);
});
