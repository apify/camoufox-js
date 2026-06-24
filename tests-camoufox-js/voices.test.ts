import { describe, expect, test } from "vitest";
import { generateVoiceSubset } from "../src/voices";

describe("generateVoiceSubset", () => {
	// The core regression this guards: every spoofable OS — including Linux —
	// must yield a non-empty voice list so the host machine's native voices
	// never leak through. A Windows/macOS host spoofing Linux previously got an
	// empty override and leaked its SAPI/NSSpeech catalog.
	test.each(["mac", "win", "lin"])("%s yields a non-empty list", (os) => {
		const voices = generateVoiceSubset(os, "en-US");
		expect(voices.length).toBeGreaterThan(0);
	});

	test("exactly one voice is marked default", () => {
		for (const os of ["mac", "win", "lin"]) {
			const defaults = generateVoiceSubset(os, "en-US").filter(
				(v) => v.isDefault,
			);
			expect(defaults).toHaveLength(1);
		}
	});

	test("default voice matches the spoofed locale prefix", () => {
		const def = generateVoiceSubset("lin", "de-DE").find((v) => v.isDefault);
		expect(def?.lang.split("-")[0]).toBe("de");
	});

	describe("Linux speech-dispatcher URIs match Firefox's format", () => {
		// Firefox SpeechDispatcherService.cpp builds:
		//   urn:moz-tts:speechd:<NS_EscapeURL(name, OnlyNonASCII|Spaces)>?<lang>
		const lin = generateVoiceSubset("lin", "en-US");

		test("prefix + ?lang suffix", () => {
			for (const v of lin) {
				expect(v.voiceUri).toMatch(/^urn:moz-tts:speechd:.+\?.+$/);
				expect(v.voiceUri.endsWith(`?${v.lang}`)).toBe(true);
			}
		});

		test("spaces are %20-escaped, ASCII punctuation is left intact", () => {
			const gb = lin.find((v) => v.name === "English (Great Britain)");
			expect(gb?.voiceUri).toBe(
				"urn:moz-tts:speechd:English%20(Great%20Britain)?en-GB",
			);
		});

		test("all Linux voices are local synthesis", () => {
			expect(lin.every((v) => v.isLocalService)).toBe(true);
		});
	});

	test("an unknown OS falls back to the macOS catalog (non-empty)", () => {
		expect(generateVoiceSubset("plan9", "en-US").length).toBeGreaterThan(0);
	});
});
