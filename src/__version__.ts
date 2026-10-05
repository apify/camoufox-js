/**
 * Camoufox version constants.
 */

export class CONSTRAINTS {
	/**
	 * The minimum and maximum supported versions of the Camoufox browser.
	 */
	static readonly MIN_VERSION: string = "alpha.1";
	/**
	 * Exclusive. The Firefox 156 builds (beta.32+) dropped properties this library still generates.
	 */
	static readonly MAX_VERSION: string = "beta.32";

	/**
	 * Minimum version with Playwright 1.61+, which sends viewport fields that older builds reject.
	 */
	static readonly PLAYWRIGHT_1_61_MIN_VERSION: string = "beta.30";
}
