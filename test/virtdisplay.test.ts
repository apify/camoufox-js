import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { VirtualDisplay } from "../src/virtdisplay";

// VIRTDISPLAY_TEST_N controls the concurrent-launch count. Default is
// kept low so the test passes on any developer box; set to 1000 (or
// whatever) to exercise real scaling. At high N you will need
// `ulimit -n` headroom — each Xvfb takes one X11 socket plus our
// -displayfd pipe.
const N = Number.parseInt(process.env.VIRTDISPLAY_TEST_N ?? "50", 10);

// Track every VirtualDisplay we spawn so afterEach can guarantee
// cleanup even if an assertion fails mid-test.
const tracked = new Set<VirtualDisplay>();

function track(vd: VirtualDisplay): VirtualDisplay {
	tracked.add(vd);
	return vd;
}

function killAllTracked(): void {
	for (const vd of tracked) {
		try {
			vd.kill();
		} catch {
			// best effort
		}
	}
	tracked.clear();
}

// Reach into the private proc to inspect process liveness — needed to
// assert kill() actually terminated Xvfb.
function procOf(vd: VirtualDisplay) {
	return (vd as unknown as { proc: { exitCode: number | null; pid?: number } })
		.proc;
}

async function waitForExit(vd: VirtualDisplay, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (procOf(vd).exitCode !== null) return;
		await sleep(25);
	}
}

describe.skipIf(process.platform !== "linux")("VirtualDisplay", () => {
	afterEach(() => {
		killAllTracked();
	});

	test("single launch returns a valid display and kill terminates Xvfb", async () => {
		const vd = track(new VirtualDisplay());
		const display = await vd.get();
		expect(display).toMatch(/^:\d+$/);
		expect(procOf(vd).exitCode).toBeNull();

		vd.kill();
		await waitForExit(vd);
		tracked.delete(vd);
		expect(procOf(vd).exitCode).not.toBeNull();
	}, 15_000);

	test("get() is idempotent within one VirtualDisplay", async () => {
		const vd = track(new VirtualDisplay());
		const a = await vd.get();
		const b = await vd.get();
		expect(a).toBe(b);
	}, 15_000);

	test(
		`${N} concurrent reservations all get unique displays`,
		async () => {
			// Every VirtualDisplay spawns its own Xvfb. Each Xvfb scans up
			// from :0 and atomically claims the first free X11 socket
			// (kernel-mediated bind, no userspace race). -displayfd reports
			// the chosen number back to us. A duplicate here would mean we
			// mis-parsed or mis-routed the displayfd output, or two Xvfbs
			// somehow bound the same socket.
			const vds = Array.from({ length: N }, () => track(new VirtualDisplay()));

			const displays = await Promise.all(vds.map((vd) => vd.get()));

			for (const d of displays) {
				expect(d).toMatch(/^:\d+$/);
			}

			const unique = new Set(displays);
			expect(unique.size).toBe(displays.length);

			// Every Xvfb is alive.
			for (const vd of vds) {
				expect(procOf(vd).exitCode).toBeNull();
			}

			// Tear them all down and confirm every Xvfb actually exited —
			// no leaked processes.
			for (const vd of vds) vd.kill();
			await Promise.all(vds.map((vd) => waitForExit(vd)));
			tracked.clear();

			for (const vd of vds) {
				expect(procOf(vd).exitCode).not.toBeNull();
			}
		},
		// Spawning thousands of Xvfb processes is genuinely slow.
		Math.max(5_000, N * 200),
	);

	test("released display numbers can be reused on the next launch", async () => {
		const a = track(new VirtualDisplay());
		const aDisplay = await a.get();

		a.kill();
		await waitForExit(a);
		tracked.delete(a);

		// Spawning a new Xvfb after release must succeed. The new display
		// number may or may not equal aDisplay — Xvfb's allocation order
		// is its concern — but we must get *some* display.
		const b = track(new VirtualDisplay());
		const bDisplay = await b.get();
		expect(bDisplay).toMatch(/^:\d+$/);

		b.kill();
		await waitForExit(b);
		tracked.delete(b);

		// Sanity: aDisplay was a valid form too.
		expect(aDisplay).toMatch(/^:\d+$/);
	}, 15_000);
});
