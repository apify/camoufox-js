import { afterEach, describe, expect, test, vi } from "vitest";
import { LeakWarning } from "../src/warnings";

describe("LeakWarning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("warn outputs a warning message", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		LeakWarning.warn("no_region");
		expect(warnSpy).toHaveBeenCalled();
		const message = warnSpy.mock.calls[0][0];
		expect(typeof message).toBe("string");
		expect(message.length).toBeGreaterThan(0);
	});

	test("warn suppresses when iKnowWhatImDoing is true", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		LeakWarning.warn("no_region", true);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("warn adds i_know_what_im_doing hint when explicitly false", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		LeakWarning.warn("no_region", false);
		expect(warnSpy).toHaveBeenCalled();
		const message = warnSpy.mock.calls[0][0];
		expect(message).toContain("i_know_what_im_doing");
	});

	test("warn does not add hint when iKnowWhatImDoing is undefined", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		LeakWarning.warn("no_region");
		expect(warnSpy).toHaveBeenCalled();
		const message = warnSpy.mock.calls[0][0];
		expect(message).not.toContain("i_know_what_im_doing");
	});

	test("LeakWarning is an Error subclass", () => {
		const warning = new LeakWarning("test");
		expect(warning).toBeInstanceOf(Error);
		expect(warning.name).toBe("LeakWarning");
	});
});
