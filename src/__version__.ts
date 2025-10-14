/**
 * Camoufox version constants.
 */

export class CONSTRAINTS {
	/**
	 * The minimum and maximum supported versions of the Camoufox browser.
	 */
	static readonly MIN_VERSION: string = "beta.19";
	static readonly MAX_VERSION: string = "1";

	static asRange(): string {
		/**
		 * Returns the version range as a string.
		 */
		return `>=${CONSTRAINTS.MIN_VERSION}, <${CONSTRAINTS.MAX_VERSION}`;
	}
}
