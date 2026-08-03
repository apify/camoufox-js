import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type { Readable } from "node:stream";
import {
	CannotExecuteXvfb,
	CannotFindXvfb,
	VirtualDisplayNotSupported,
} from "./exceptions.js";
import { OS_NAME } from "./pkgman.js";

// Safe timeout for xvfb writing display num, prevents infinite hang
const DISPLAYFD_READ_TIMEOUT_MS = 10_000;

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
	 * Launch Xvfb with -displayfd 3 so the kernel/Xvfb itself picks a free
	 * display number atomically and reports it back to us. Avoids userspace race conditions
	 */
	private spawnXvfb(): ChildProcess {
		const xvfbPath = this.xvfb_path;
		const cmd = [xvfbPath, "-displayfd", "3", ...this.xvfb_args];
		if (this.debug) {
			console.log("Starting virtual display:", cmd.join(" "));
		}
		// Force Mesa software GLX to avoid GPU contention delays, we don't use the GPU anyways
		return spawn(cmd[0], cmd.slice(1), {
			stdio: [
				"ignore",
				this.debug ? "inherit" : "ignore",
				this.debug ? "inherit" : "ignore",
				"pipe", // fd 3 — Xvfb writes "<display>\n" here
			],
			detached: true,
			env: {
				...process.env,
				__GLX_VENDOR_LIBRARY_NAME: "mesa",
				LIBGL_ALWAYS_SOFTWARE: "1",
			},
		});
	}

	public async get(): Promise<string> {
		VirtualDisplay.assert_linux();

		if (!this.proc) {
			this.proc = this.spawnXvfb();
			const stream = this.proc.stdio[3] as Readable;
			const timer = setTimeout(
				() =>
					stream.destroy(
						new CannotExecuteXvfb(
							`Xvfb did not report a display within ${DISPLAYFD_READ_TIMEOUT_MS}ms`,
						),
					),
				DISPLAYFD_READ_TIMEOUT_MS,
			);
			let buf = "";
			try {
				for await (const chunk of stream) {
					buf += chunk;
					if (buf.includes("\n")) break;
				}
			} catch (err) {
				this.kill();
				throw err;
			} finally {
				clearTimeout(timer);
			}
			const n = Number.parseInt(buf, 10);
			if (!Number.isFinite(n)) {
				this.kill();
				throw new CannotExecuteXvfb(
					`Xvfb did not report a display (got ${JSON.stringify(buf)}, exit=${this.proc.exitCode})`,
				);
			}
			this._display = n;
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
			this.proc.kill();
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
