import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright-core";
import { describe, expect, test } from "vitest";
import { Camoufox, launchServer } from "../src";

const TEST_CASES = [
	{ os: "linux", userAgentRegex: /Linux/i },
	{ os: "windows", userAgentRegex: /Windows/i },
	{ os: "macos", userAgentRegex: /Mac OS/i },
];

describe("virtual display", () => {
	test("should launch", async () => {
		const browser = await Camoufox({
			os: "linux",
			headless: "virtual",
		} as any);

		const page = await browser.newPage();
		await page.goto("https://api.apify.com/v2/browser-info");
		const userAgent = await page.evaluate(() => navigator.userAgent.toString());
		expect(userAgent).toMatch(/Linux/i);
		await browser.close();
	}, 10e3);
});

describe("Fingerprint consistency", () => {
	test.each(TEST_CASES)(
		"User-Agent matches set OS ($os)",
		async ({ os, userAgentRegex }) => {
			const browser = await Camoufox({
				os,
				headless: true,
			} as any);

			const page = await browser.newPage();

			await page.goto("https://api.apify.com/v2/browser-info");

			const data = await page.evaluate(() =>
				JSON.parse(document.querySelector("pre")?.textContent ?? ""),
			);
			const httpAgent = data.headers["user-agent"];
			const jsAgent = await page.evaluate(() => navigator.userAgent.toString());

			expect(httpAgent).toEqual(jsAgent);
			expect(httpAgent).toMatch(userAgentRegex);

			TEST_CASES.forEach(({ os: testOs, userAgentRegex }) => {
				if (testOs !== os) {
					expect(httpAgent).not.toMatch(userAgentRegex);
				}
			});

			await browser.close();
		},
		10e3,
	);
});

test("Playwright connects to Camoufox server", async () => {
	const server = await launchServer({
		headless: true,
	});

	const browser = await firefox.connect(server.wsEndpoint());
	const page = await browser.newPage();
	await page.goto("https://api.apify.com/v2/browser-info");

	const userAgent = await page.evaluate(() => navigator.userAgent.toString());
	expect(userAgent).toMatch(/Firefox/);
	await browser.close();

	await server.close();
}, 30e3);

test("Persistent context works", async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), "user_data_"));

	{
		const context = await Camoufox({
			user_data_dir: userDataDir,
			headless: true,
		});

		const page = await context.newPage();
		await page.goto("https://example.com");

		await page.evaluate(() => {
			document.cookie =
				"name=value; path=/; domain=example.com; expires=Fri, 31 Dec 9999 23:59:59 GMT";
		});
		await page.close();
		await context.close();
	}

	let readCookies: any = null;

	{
		const context = await Camoufox({
			user_data_dir: userDataDir,
			headless: true,
		});

		const page = await context.newPage();
		await page.goto("https://example.com");

		readCookies = await page.evaluate(() => {
			const cookies = document.cookie.split("; ").reduce((acc, cookie) => {
				const [name, value] = cookie.split("=");
				acc[name] = value;
				return acc;
			}, {});
			return cookies;
		});

		await page.close();
		await context.close();
	}

	expect(readCookies).toEqual({ name: "value" });
}, 30e3);
