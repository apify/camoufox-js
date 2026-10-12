import { describe, expect, test } from "vitest";
import { getPossiblePairs, sampleWebGL } from "../src/webgl/sample";

// Software rasterizers are legitimate dataset rows (the db is built from real
// user submissions) but must never win the weighted draw: pages can read the
// renderer string and a GPU-less software renderer is one of the strongest
// "this is a bot" signals there is. daijro/camoufox#743 applied the same rule
// to the python generator; #276 documents the dataset contamination.

const SOFTWARE_RENDERER_PATTERNS = [
	/llvmpipe/i,
	/SwiftShader/i,
	/Basic Render/i,
	/Generic Renderer/i,
];

function isSoftwareRenderer(renderer: unknown): boolean {
	return typeof renderer === "string" && SOFTWARE_RENDERER_PATTERNS.some((p) => p.test(renderer));
}

// The sampled blob is the camoufox config fragment: the renderer strings live
// under the spoofing keys, not top-level.
function fingerprintRenderer(fp: { renderer?: unknown; "webGl:renderer"?: unknown }): string {
	return typeof fp["webGl:renderer"] === "string" ? fp["webGl:renderer"] : String(fp.renderer);
}

describe("sampleWebGL weighted draw", () => {
	test("never samples a software rasterizer", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const fp = await sampleWebGL("lin");
			const renderer = fingerprintRenderer(fp);
			expect(isSoftwareRenderer(renderer)).toBe(false);
			seen.add(renderer);
		}
		// The filtered draw still covers the real hardware devices, it has not
		// collapsed onto a single row.
		expect(seen.size).toBeGreaterThan(2);
	}, 60_000);

	for (const os of ["win", "mac", "lin"] as const) {
		test(`no software renderer wins the draw on ${os}`, async () => {
			for (let i = 0; i < 300; i++) {
				const fp = await sampleWebGL(os);
				expect(isSoftwareRenderer(fingerprintRenderer(fp))).toBe(false);
			}
		}, 60_000);
	}

	test("explicit pairs still resolve, including software rows", async () => {
		const pairs = await getPossiblePairs();
		const softwarePair = pairs.lin?.find((p) => isSoftwareRenderer(p.renderer));
		// The shipped dataset does contain llvmpipe rows for linux.
		expect(softwarePair).toBeDefined();
		const fp = await sampleWebGL("lin", softwarePair!.vendor, softwarePair!.renderer);
		expect(fingerprintRenderer(fp)).toBe(softwarePair!.renderer);
	}, 30_000);

	test("unknown explicit pairs still report the full (unfiltered) pair list", async () => {
		const pairs = await getPossiblePairs();
		expect(Array.isArray(pairs.lin)).toBe(true);
		expect(pairs.lin!.length).toBeGreaterThanOrEqual(11);
	});
});
