import { describe, expect, test } from "vitest";
import { Camoufox } from "../src";

describe("GeoIP integration", () => {
	test("geoip auto-detect sets timezone, locale, and language", async () => {
		const browser = await Camoufox({
			headless: true,
			geoip: true,
			i_know_what_im_doing: true,
		});

		const page = await browser.newPage();

		const { timezone, locale, language } = await page.evaluate(() => ({
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			language: navigator.language,
		}));

		// Should be a valid IANA timezone like "America/Denver"
		expect(timezone).toMatch(/^[A-Z][a-z]+\/[A-Za-z_]+/);
		// Should be a valid locale like "en-US"
		expect(locale).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
		// Should be a valid BCP 47 language tag
		expect(language).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);

		await browser.close();
	}, 30e3);
});
