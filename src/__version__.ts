/**
 * Camoufox version constants.
 */

export class CONSTRAINTS {
	/**
	 * The minimum and maximum supported versions of the Camoufox browser.
	 */
	static readonly MIN_VERSION: string = "alpha.1";
	static readonly MAX_VERSION: string = "1";

	/**
	 * Minimum browser releases required by newer Playwright versions, as [[major, minor], release].
	 * Playwright 1.61 sends viewport fields that builds before beta.30 reject.
	 */
	static readonly PLAYWRIGHT_BROWSER_FLOORS: [[number, number], string][] = [
		[[1, 61], "beta.30"],
	];

	static asRange(): string {
		/**
		 * Returns the version range as a string.
		 */
		return `>=${CONSTRAINTS.MIN_VERSION}, <${CONSTRAINTS.MAX_VERSION}`;
	}
}
