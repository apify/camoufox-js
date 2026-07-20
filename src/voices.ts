import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export interface Voice {
	lang: string;
	name: string;
	voiceUri: string;
	isDefault: boolean;
	isLocalService: boolean;
}

interface RawVoiceCatalog {
	mac: string[];
	win: string[];
	lin: string[];
}

let cache: RawVoiceCatalog | null = null;

function loadCatalog(): RawVoiceCatalog {
	if (cache) return cache;
	const data = JSON.parse(
		fs.readFileSync(path.join(currentDir, "data-files", "voices.json"), "utf8"),
	);
	cache = { mac: data.mac ?? [], win: data.win ?? [], lin: data.lin ?? [] };
	return cache;
}

const ESSENTIAL_MAC = new Set([
	"Samantha",
	"Alex",
	"Fred",
	"Victoria",
	"Karen",
	"Daniel",
]);

// Real Firefox URI prefixes per backend.
// macOS NSSpeechSynthesizer -> "urn:moz-tts:osx:<identifier>"
// Windows SAPI -> "urn:moz-tts:sapi:<token>"
// Linux speech-dispatcher -> "urn:moz-tts:speechd:<name>?<lang>" (see below)
const URI_PREFIX = {
	mac: "urn:moz-tts:osx:",
	win: "urn:moz-tts:sapi:",
	lin: "urn:moz-tts:speechd:",
} as const;

function uriSlug(name: string): string {
	// Real Apple identifiers look like "com.apple.voice.compact.en-US.Samantha".
	// We can't synthesize those exactly without Apple's catalog, but a stable
	// dotted slug derived from the voice name is shape-plausible and stable
	// across launches (same fingerprint hash), which is what matters for
	// detectors. They check format/prefix/structure, not Apple-catalog membership.
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ".")
		.replace(/^\.|\.$/g, "");
}

function voiceUriFor(
	osKey: "mac" | "win" | "lin",
	name: string,
	lang: string,
): string {
	if (osKey === "lin") {
		// Match Firefox's SpeechDispatcherService.cpp exactly:
		//   uri = "urn:moz-tts:speechd:" + NS_EscapeURL(name, OnlyNonASCII|Spaces)
		//          + "?" + lang
		// i.e. spaces -> %20 and non-ASCII bytes -> %XX, but ASCII punctuation
		// like ()/, is left intact. encodeURIComponent over-escapes (it would
		// turn "(" into %28), so escape only spaces + non-ASCII to mirror the
		// real backend byte-for-byte.
		const escaped = Array.from(name)
			.map((ch) => {
				if (ch === " ") return "%20";
				// ASCII (code <= 0x7F) is passed through verbatim, matching
				// esc_OnlyNonASCII; everything else is percent-encoded per UTF-8 byte.
				if (ch.charCodeAt(0) <= 0x7f) return ch;
				return Array.from(new TextEncoder().encode(ch))
					.map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
					.join("");
			})
			.join("");
		return `${URI_PREFIX.lin}${escaped}?${lang}`;
	}
	return `${URI_PREFIX[osKey]}${uriSlug(name)}`;
}

function parseVoiceEntry(
	entry: string,
	osKey: "mac" | "win" | "lin",
): Voice | null {
	// Format: "Name:lang:type" where type is "local" or "remote".
	// Voice names can contain parens but not colons (verified across the dataset),
	// so a simple last-two-colons split is safe.
	const lastColon = entry.lastIndexOf(":");
	if (lastColon < 0) return null;
	const type = entry.slice(lastColon + 1);
	const beforeType = entry.slice(0, lastColon);
	const langColon = beforeType.lastIndexOf(":");
	if (langColon < 0) return null;
	const lang = beforeType.slice(langColon + 1);
	const name = beforeType.slice(0, langColon);
	if (!name || !lang) return null;

	return {
		name,
		lang,
		voiceUri: voiceUriFor(osKey, name, lang),
		isDefault: false,
		isLocalService: type === "local",
	};
}

function osToKey(os: string): "mac" | "win" | "lin" {
	if (os === "mac" || os === "macos") return "mac";
	if (os === "win" || os === "windows") return "win";
	return "lin";
}

/**
 * Generate a per-OS voice list shaped for the camoufox `voices` MaskConfig key.
 *
 *   macOS:   essential voices + random 40-80% of the rest
 *   Windows: full set (only ~50 voices, subsetting reads as suspicious)
 *   Linux:   full set. A Linux Firefox enumerates speech-dispatcher's
 *            voices; with the default espeak-ng backend that's a fixed
 *            ~131-voice base-language list, identical across installs (the
 *            per-speaker +variant combos are espeak-ng internals, not
 *            distinct speechd voices Firefox sees). Because it's fixed,
 *            subsetting it would itself be a tell, so ship the whole list —
 *            same rationale as Windows. This runs regardless of the HOST
 *            OS: a Windows/macOS host spoofing a Linux identity would
 *            otherwise leak its native SAPI/NSSpeech voices.
 *
 * Returned shape matches MaskConfig::MVoices() — array of objects with
 * {lang, name, voiceUri, isDefault, isLocalService}. Anything else
 * is silently dropped by the C++ parser.
 */
export function generateVoiceSubset(os: string, locale?: string): Voice[] {
	const osKey = osToKey(os);
	const catalog = loadCatalog();
	const raw = catalog[osKey];
	if (!raw || raw.length === 0) return [];

	const parsed = raw
		.map((e) => parseVoiceEntry(e, osKey))
		.filter((v): v is Voice => v !== null);

	let selected: Voice[];
	if (osKey === "win" || osKey === "lin") {
		// Full deterministic set — both espeak-ng (Linux) and SAPI (Windows)
		// expose a fixed list that's the same across installs, so subsetting
		// would be anomalous.
		selected = parsed;
	} else if (osKey === "mac") {
		const essential = parsed.filter((v) => ESSENTIAL_MAC.has(v.name));
		const nonEssential = parsed.filter((v) => !ESSENTIAL_MAC.has(v.name));
		const pct = 40 + Math.floor(Math.random() * 41); // 40-80%
		const count = Math.round((pct / 100) * nonEssential.length);
		const shuffled = nonEssential
			.map((v) => ({ v, k: Math.random() }))
			.sort((a, b) => a.k - b.k)
			.slice(0, Math.min(count, nonEssential.length))
			.map((x) => x.v);
		selected = [...essential, ...shuffled];
	} else {
		// osKey is "mac" | "win" | "lin"; all are handled above.
		const _exhaustive: never = osKey;
		return _exhaustive;
	}

	// Mark default voice. CreepJS's speech detector compares the default
	// voice's lang prefix to Intl.DateTimeFormat().resolvedOptions().locale
	// and flags `voiceLangMismatch` if they diverge — which downgrades
	// timezone entropy in their analysis. Match the spoofed locale prefix
	// so a de-DE locale picks Anna, not Alex.
	const localePrefix = locale ? locale.split("-")[0].toLowerCase() : "en";
	let idx = selected.findIndex(
		(v) => v.lang.toLowerCase() === locale?.toLowerCase(),
	);
	if (idx < 0) {
		idx = selected.findIndex(
			(v) => v.lang.split("-")[0].toLowerCase() === localePrefix,
		);
	}
	if (idx < 0) idx = 0;
	if (selected.length > 0)
		selected[idx] = { ...selected[idx], isDefault: true };

	return selected;
}
