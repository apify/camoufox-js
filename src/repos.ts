/**
 * Camoufox browser repositories.
 *
 * Port of `repos.yml` from the Python library. Each entry describes a GitHub
 * repository (with optional fallbacks) that publishes Camoufox builds, the
 * asset naming pattern and the range of builds this library can talk to,
 * per channel. A missing channel range means "all builds are supported".
 */

export interface ChannelBounds {
	min?: string;
	max?: string;
}

export interface RepoDefinition {
	/** Primary GitHub repo followed by fallbacks, as `owner/name`. */
	repo: string[];
	/** Display name, e.g. `Official`. Lowercased in channel strings. */
	name: string;
	/** Release asset pattern using `{name}`, `{version}`, `{build}`, `{os}`, `{arch}`. */
	pattern: string;
	browser?: {
		stable?: ChannelBounds;
		prerelease?: ChannelBounds;
	};
}

/** Name of the repository used when none is specified (`official/stable`). */
export const DEFAULT_BROWSER_REPO = "Official";

export const BROWSER_REPOS: RepoDefinition[] = [
	{
		// Fallback to camoufox org
		repo: ["daijro/camoufox", "camoufox/camoufox"],
		name: "Official",
		pattern: "{name}-{version}-{build}-{os}.{arch}.zip",
		browser: {
			// Stable channel
			stable: { min: "beta.19", max: "1" },
			// Prerelease channel (including "alpha.*" builds) matches all versions
		},
	},
	{
		repo: ["coryking/camoufox"],
		name: "CoryKing",
		pattern: "{name}-{version}-{build}-{os}.{arch}.zip",
		// Assume all browsers
	},
	{
		repo: ["JWriter20/camoufox"],
		name: "JWriter20",
		pattern: "{name}-{version}-{build}-{os}.{arch}.zip",
		// Assume all browsers
	},
];
