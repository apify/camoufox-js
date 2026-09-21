/**
 * Platform detection and install location.
 *
 * Kept in a leaf module (no imports from the rest of the package) so that
 * `pkgman.ts` and `multiversion.ts` can both build their paths from
 * INSTALL_DIR at load time without a circular import.
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UnsupportedOS } from "./exceptions.js";

export type OsName = "mac" | "win" | "lin";

export const ARCH_MAP: { [key: string]: string } = {
	x64: "x86_64",
	ia32: "i686",
	arm64: "arm64",
	arm: "arm64",
};

export const OS_MAP: { [key: string]: OsName } = {
	darwin: "mac",
	linux: "lin",
	win32: "win",
};

if (!(process.platform in OS_MAP)) {
	throw new UnsupportedOS(`OS ${process.platform} is not supported`);
}

export const OS_NAME: OsName = OS_MAP[process.platform];

export const OS_ARCH_MATRIX: { [key: string]: string[] } = {
	win: ["x86_64", "i686"],
	mac: ["x86_64", "arm64"],
	lin: ["x86_64", "arm64", "i686"],
};

export const LAUNCH_FILE: { [key: string]: string } = {
	win: "camoufox.exe",
	mac: "../MacOS/camoufox",
	lin: "camoufox-bin",
};

const currentDir =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export const LOCAL_DATA: string = path.join(currentDir, "data-files");

/** Directory of this package's `package.json` (works from both `src/` and `dist/`). */
export const PACKAGE_ROOT: string = path.join(currentDir, "..");

export function getAsBooleanFromENV(
	name: string,
	defaultValue?: boolean | undefined,
): boolean {
	const value = process.env[name];
	if (value === "false" || value === "0") return false;
	if (value) return true;
	return !!defaultValue;
}

export function userCacheDir(appName: string): string {
	if (OS_NAME === "win") {
		return path.join(
			os.homedir(),
			"AppData",
			"Local",
			appName,
			appName,
			"Cache",
		);
	} else if (OS_NAME === "mac") {
		return path.join(os.homedir(), "Library", "Caches", appName);
	} else {
		// Per the XDG spec a relative XDG_CACHE_HOME is invalid and ignored.
		const xdg = process.env.XDG_CACHE_HOME;
		return path.join(
			xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache"),
			appName,
		);
	}
}

/**
 * Directory the Camoufox browsers are downloaded to and launched from.
 * Defaults to the per-user cache directory; set CAMOUFOX_INSTALL_DIR to
 * relocate it (e.g. into a container image layer when the home directory
 * is ephemeral or persisted separately).
 *
 * Layout (shared with the Python library):
 *   browsers/<repo>/<version>-<build>-<sha8>/   installed browsers
 *   config.json                                  active version / channel / pin
 *   repo_cache.json                              synced release catalog
 */
export const INSTALL_DIR: string = process.env.CAMOUFOX_INSTALL_DIR
	? path.resolve(process.env.CAMOUFOX_INSTALL_DIR)
	: userCacheDir("camoufox");
