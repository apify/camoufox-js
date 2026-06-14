import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { accessSync, constants as fsConstants, promises as fsP } from "node:fs";
import {
	CannotExecuteXvfb,
	CannotFindXvfb,
	VirtualDisplayNotSupported,
} from "./exceptions.js";
import { OS_NAME } from "./pkgman.js";

// Per-spawn cap on how long we wait for an Xvfb to either win the .X{N}-lock
// race or exit on collision. Xvfb fails its socket-bind in ~50ms on collision
// and writes /tmp/.X{N}-lock in well under 1s on success — 10s is generous and
// gives headroom under high apply-worker concurrency.
const BIND_OR_EXIT_TIMEOUT_MS = 15_000;
const MAX_DISPLAY_RETRIES = 5;

// Display number is just an unsigned int; with -nolisten tcp there's no port
// constraint, so we draw from a large sparse range. Birthday math: at 1000
// concurrent spawns, collision probability is ~0.05% — retries cover the rest.
// Lower bound stays clear of low displays commonly used by other X servers.
const DISPLAY_MIN = 1000;
const DISPLAY_MAX = 1_000_000_000;

function pickDisplayNumber(): number {
	return randomInt(DISPLAY_MIN, DISPLAY_MAX);
}

export class VirtualDisplay {
	private debug: boolean;
	private proc: ChildProcess | null = null;
	private _display: number | null = null;

	constructor(debug: boolean = false) {
		this.debug = debug;
	}

	private get xvfb_args(): string[] {
		return [
			"-screen",
			"0",
			"1x1x24",
			"-ac",
			"-nolisten",
			"tcp",
			"-extension",
			"RENDER",
			"+extension",
			"GLX",
			"-extension",
			"COMPOSITE",
			"-extension",
			"XVideo",
			"-extension",
			"XVideo-MotionCompensation",
			"-extension",
			"XINERAMA",
			"-fp",
			"built-ins",
			"-nocursor",
			"-br",
		];
	}

	private get xvfb_path(): string {
		let resolved: string;
		try {
			resolved = execFileSync("which", ["Xvfb"]).toString().trim();
		} catch {
			throw new CannotFindXvfb("Please install Xvfb to use headless mode.");
		}
		if (!resolved) {
			throw new CannotFindXvfb("Please install Xvfb to use headless mode.");
		}
		try {
			accessSync(resolved, fsConstants.X_OK);
		} catch {
			throw new CannotExecuteXvfb(
				`I do not have permission to execute Xvfb: ${resolved}`,
			);
		}
		return resolved;
	}

	/**
	 * Spawn Xvfb with an explicit display number. Returns the child process.
	 *
	 * Avoids `-displayfd N`, which makes Xvfb walk display numbers from 0
	 * upward and re-init GLX on every collision — the dominant cost under
	 * concurrent bursts.
	 */
	private spawnOne(displayNum: number): ChildProcess {
		const xvfbPath = this.xvfb_path;
		const cmd = [xvfbPath, `:${displayNum}`, ...this.xvfb_args];
		if (this.debug) {
			console.log("Starting virtual display:", cmd.join(" "));
		}
		// Force Mesa software GLX to avoid GPU contention delays, we don't use the GPU anyways
		return spawn(cmd[0], cmd.slice(1), {
			stdio: [
				"ignore",
				this.debug ? "inherit" : "ignore",
				this.debug ? "inherit" : "ignore",
			],
			detached: true,
			env: {
				...process.env,
				__GLX_VENDOR_LIBRARY_NAME: "mesa",
				LIBGL_ALWAYS_SOFTWARE: "1",
			},
		});
	}

	/**
	 * Did our spawned Xvfb win the kernel race for display N?
	 *   - Our process exits → lost the race → caller should retry
	 *   - /tmp/.X{N}-lock contains our PID → won → return true
	 * The X{N}-lock O_CREAT|O_EXCL is the same atomic primitive Xvfb uses
	 * with -displayfd, so race-safety is identical.
	 */
	private async waitForBindOrExit(
		proc: ChildProcess,
		displayNum: number,
		timeoutMs: number,
	): Promise<boolean> {
		const lockPath = `/tmp/.X${displayNum}-lock`;
		const startMs = Date.now();
		while (Date.now() - startMs < timeoutMs) {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				return false; // Xvfb exited — collision (or other failure)
			}
			try {
				const content = await fsP.readFile(lockPath, "utf8");
				const lockPid = Number.parseInt(content.trim(), 10);
				if (Number.isFinite(lockPid) && lockPid === proc.pid) {
					return true;
				}
			} catch {
				// lock file not present yet, keep polling
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		return false;
	}

	public async get(): Promise<string> {
		VirtualDisplay.assert_linux();

		if (!this.proc) {
			let lastError: string | null = null;
			for (let attempt = 0; attempt < MAX_DISPLAY_RETRIES; attempt++) {
				const candidateN = pickDisplayNumber();
				const proc = this.spawnOne(candidateN);
				const won = await this.waitForBindOrExit(
					proc,
					candidateN,
					BIND_OR_EXIT_TIMEOUT_MS,
				);
				if (won) {
					this.proc = proc;
					this._display = candidateN;
					if (this.debug) {
						console.log(
							`Virtual display ready: :${candidateN} (attempts=${attempt + 1})`,
						);
					}
					return `:${this._display}`;
				}
				lastError = `:${candidateN} collision or timeout (exit=${proc.exitCode}, signal=${proc.signalCode})`;
				if (proc.exitCode === null && !proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}
			throw new CannotExecuteXvfb(
				`Failed to allocate a virtual display after ${MAX_DISPLAY_RETRIES} attempts. Last: ${lastError ?? "unknown"}`,
			);
		} else if (this.debug) {
			console.log(`Using virtual display: ${this._display}`);
		}

		return `:${this._display}`;
	}

	public kill(): void {
		if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
			if (this.debug) {
				console.log("Terminating virtual display:", this._display);
			}
			try {
				this.proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}

	private static assert_linux(): void {
		if (OS_NAME !== "lin") {
			throw new VirtualDisplayNotSupported(
				"Virtual display is only supported on Linux.",
			);
		}
	}
}
