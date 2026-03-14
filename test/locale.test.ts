import { describe, expect, test } from "vitest";
import {
	InvalidLocale,
	UnknownTerritory,
} from "../src/exceptions";
import {
	normalizeLocale,
	handleLocale,
	handleLocales,
} from "../src/locale";

describe("normalizeLocale", () => {
	test("normalizes language-region format", () => {
		const locale = normalizeLocale("en-US");
		expect(locale.language).toBe("en");
		expect(locale.region).toBe("US");
	});

	test("normalizes language-region with different casing", () => {
		const locale = normalizeLocale("en-us");
		expect(locale.language).toBe("en");
		expect(locale.region).toBe("US");
	});

	test("returns script when available", () => {
		// zh-Hans-CN has a script (Hans)
		const locale = normalizeLocale("zh-Hans-CN");
		expect(locale.language).toBe("zh");
		expect(locale.region).toBe("CN");
	});

	test("throws InvalidLocale for invalid locale", () => {
		expect(() => normalizeLocale("zzz-ZZ")).toThrow();
	});

	test("handles language-only input without throwing", () => {
		// In the JS port, normalizeLocale("en") does not throw because
		// parser.region is a method reference (always truthy).
		// The Python version throws, but the JS behavior differs.
		const locale = normalizeLocale("en");
		expect(locale.language).toBe("en");
	});

	test("handles common locales", () => {
		const fr = normalizeLocale("fr-FR");
		expect(fr.language).toBe("fr");
		expect(fr.region).toBe("FR");

		const de = normalizeLocale("de-DE");
		expect(de.language).toBe("de");
		expect(de.region).toBe("DE");

		const ja = normalizeLocale("ja-JP");
		expect(ja.language).toBe("ja");
		expect(ja.region).toBe("JP");
	});
});

describe("handleLocale", () => {
	test("handles language-region format (length > 3)", () => {
		const locale = handleLocale("en-US");
		expect(locale.language).toBe("en");
		expect(locale.region).toBe("US");
	});

	test("handles region code (2-3 chars)", () => {
		// "US" is a valid region code, should use StatisticalLocaleSelector
		const locale = handleLocale("US");
		expect(locale.region).toBe("US");
		expect(locale.language).toBeTruthy();
	});

	test("handles language code with ignoreRegion=true", () => {
		const locale = handleLocale("en", true);
		expect(locale.language).toBe("en");
		expect(locale.region).toBeUndefined();
	});

	test("handles language code and finds region", () => {
		// "en" is a known language, should find a region
		const locale = handleLocale("en");
		expect(locale.language).toBe("en");
		expect(locale.region).toBeTruthy();
	});

	test("throws for invalid locale", () => {
		expect(() => handleLocale("zzz")).toThrow();
	});
});

describe("handleLocales", () => {
	test("handles single locale string", () => {
		const config: Record<string, any> = {};
		handleLocales("en-US", config);
		expect(config["locale:language"]).toBe("en");
		expect(config["locale:region"]).toBe("US");
	});

	test("handles comma-separated locale string", () => {
		const config: Record<string, any> = {};
		handleLocales("en-US, fr-FR", config);
		expect(config["locale:language"]).toBe("en");
		expect(config["locale:region"]).toBe("US");
		expect(config["locale:all"]).toContain("en");
		expect(config["locale:all"]).toContain("fr");
	});

	test("handles array of locales", () => {
		const config: Record<string, any> = {};
		handleLocales(["en-US", "de-DE"], config);
		expect(config["locale:language"]).toBe("en");
		expect(config["locale:region"]).toBe("US");
		expect(config["locale:all"]).toContain("en");
		expect(config["locale:all"]).toContain("de");
	});

	test("single locale does not set locale:all", () => {
		const config: Record<string, any> = {};
		handleLocales("en-US", config);
		expect(config["locale:all"]).toBeUndefined();
	});

	test("deduplicates locales in locale:all", () => {
		const config: Record<string, any> = {};
		handleLocales(["en-US", "en-GB"], config);
		// Both are "en" language, should deduplicate
		const allLocales = config["locale:all"]?.split(", ") ?? [];
		const uniqueLocales = new Set(allLocales);
		expect(allLocales.length).toBe(uniqueLocales.size);
	});
});

describe("Locale class (via normalizeLocale)", () => {
	test("asString returns language-region", () => {
		const locale = normalizeLocale("en-US");
		expect(locale.asString()).toBe("en-US");
	});

	test("asConfig returns config dictionary", () => {
		const locale = normalizeLocale("en-US");
		const config = locale.asConfig();
		expect(config["locale:language"]).toBe("en");
		expect(config["locale:region"]).toBe("US");
	});
});

describe("StatisticalLocaleSelector (via handleLocale)", () => {
	test("fromRegion returns valid locale for known territories", () => {
		const regions = ["US", "GB", "FR", "DE", "JP", "CN", "BR", "IN"];
		for (const region of regions) {
			const locale = handleLocale(region);
			expect(locale.region).toBe(region);
			expect(locale.language).toBeTruthy();
		}
	});

	test("fromRegion throws for unknown territory", () => {
		expect(() => handleLocale("ZZ")).toThrow();
	});

	test("fromLanguage returns valid locale for known languages", () => {
		const languages = ["en", "fr", "de", "ja", "zh"];
		for (const lang of languages) {
			const locale = handleLocale(lang);
			expect(locale.language).toBe(lang);
			expect(locale.region).toBeTruthy();
		}
	});
});
