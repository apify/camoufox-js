/**
 * Per-context fingerprint helpers for CloverLabs Camoufox builds.
 *
 * These utilities generate `addInitScript` code that calls the self-destructing
 * `window.setXxx()` functions available in CloverLabs builds with per-context
 * fingerprint isolation.
 *
 * Usage with Playwright:
 *   const context = await browser.newContext();
 *   await applyContextFingerprint(context, fingerprint);
 *
 * Or apply individual overrides:
 *   await context.addInitScript(setCanvasSeed(12345));
 */

/** Generate init script for per-context canvas fingerprint seed */
export function setCanvasSeed(seed: number): string {
	return `window.setCanvasSeed?.(${seed});`;
}

/** Generate init script for per-context audio fingerprint seed */
export function setAudioFingerprintSeed(seed: number): string {
	return `window.setAudioFingerprintSeed?.(${seed});`;
}

/** Generate init script for per-context font spacing seed */
export function setFontSpacingSeed(seed: number): string {
	return `window.setFontSpacingSeed?.(${seed});`;
}

/** Generate init script for per-context font list */
export function setFontList(fonts: string[]): string {
	return `window.setFontList?.(${JSON.stringify(fonts)});`;
}

/** Generate init script for per-context navigator.platform */
export function setNavigatorPlatform(platform: string): string {
	return `window.setNavigatorPlatform?.(${JSON.stringify(platform)});`;
}

/** Generate init script for per-context navigator.oscpu */
export function setNavigatorOscpu(oscpu: string): string {
	return `window.setNavigatorOscpu?.(${JSON.stringify(oscpu)});`;
}

/** Generate init script for per-context navigator.hardwareConcurrency */
export function setNavigatorHardwareConcurrency(cores: number): string {
	return `window.setNavigatorHardwareConcurrency?.(${cores});`;
}

/** Generate init script for per-context WebGL vendor */
export function setWebGLVendor(vendor: string): string {
	return `window.setWebGLVendor?.(${JSON.stringify(vendor)});`;
}

/** Generate init script for per-context WebGL renderer */
export function setWebGLRenderer(renderer: string): string {
	return `window.setWebGLRenderer?.(${JSON.stringify(renderer)});`;
}

/** Generate init script for per-context screen dimensions */
export function setScreenDimensions(width: number, height: number): string {
	return `window.setScreenDimensions?.(${width}, ${height});`;
}

/** Generate init script for per-context screen color depth */
export function setScreenColorDepth(depth: number): string {
	return `window.setScreenColorDepth?.(${depth});`;
}

/** Generate init script for per-context screen available dimensions */
export function setScreenAvailDimensions(
	width: number,
	height: number,
): string {
	return `window.setScreenAvailDimensions?.(${width}, ${height});`;
}

/** Generate init script for per-context timezone */
export function setTimezone(tz: string): string {
	return `window.setTimezone?.(${JSON.stringify(tz)});`;
}

/** Generate init script for per-context speech voices */
export function setSpeechVoices(voices: string[]): string {
	return `window.setSpeechVoices?.(${JSON.stringify(voices)});`;
}

/** Generate init script for per-context WebRTC IPv4 */
export function setWebRTCIPv4(ip: string): string {
	return `window.setWebRTCIPv4?.(${JSON.stringify(ip)});`;
}

/** Generate init script for per-context WebRTC IPv6 */
export function setWebRTCIPv6(ip: string): string {
	return `window.setWebRTCIPv6?.(${JSON.stringify(ip)});`;
}

/**
 * Configuration for per-context fingerprint overrides.
 * All fields are optional - only provided fields will be applied.
 */
export interface ContextFingerprint {
	/** Canvas fingerprint seed */
	canvasSeed?: number;
	/** Audio fingerprint seed */
	audioSeed?: number;
	/** Font spacing seed */
	fontSpacingSeed?: number;
	/** List of fonts to appear "installed" */
	fonts?: string[];
	/** navigator.platform value */
	platform?: string;
	/** navigator.oscpu value */
	oscpu?: string;
	/** navigator.hardwareConcurrency (CPU cores) */
	hardwareConcurrency?: number;
	/** WebGL UNMASKED_VENDOR_WEBGL */
	webglVendor?: string;
	/** WebGL UNMASKED_RENDERER_WEBGL */
	webglRenderer?: string;
	/** Screen width and height */
	screen?: { width: number; height: number };
	/** Screen color depth */
	colorDepth?: number;
	/** Available screen dimensions */
	availScreen?: { width: number; height: number };
	/** Timezone identifier (e.g. "America/New_York") */
	timezone?: string;
	/** Speech synthesis voices list */
	speechVoices?: string[];
	/** WebRTC IPv4 address */
	webrtcIPv4?: string;
	/** WebRTC IPv6 address */
	webrtcIPv6?: string;
}

/**
 * Apply per-context fingerprint overrides to a Playwright BrowserContext.
 * Only works with CloverLabs Camoufox builds that support per-context spoofing.
 *
 * Uses optional chaining (`?.`) so calls are silently ignored on standard builds.
 */
export async function applyContextFingerprint(
	context: { addInitScript: (script: string) => Promise<void> },
	fingerprint: ContextFingerprint,
): Promise<void> {
	const scripts: string[] = [];

	if (fingerprint.canvasSeed != null) {
		scripts.push(setCanvasSeed(fingerprint.canvasSeed));
	}
	if (fingerprint.audioSeed != null) {
		scripts.push(setAudioFingerprintSeed(fingerprint.audioSeed));
	}
	if (fingerprint.fontSpacingSeed != null) {
		scripts.push(setFontSpacingSeed(fingerprint.fontSpacingSeed));
	}
	if (fingerprint.fonts) {
		scripts.push(setFontList(fingerprint.fonts));
	}
	if (fingerprint.platform) {
		scripts.push(setNavigatorPlatform(fingerprint.platform));
	}
	if (fingerprint.oscpu) {
		scripts.push(setNavigatorOscpu(fingerprint.oscpu));
	}
	if (fingerprint.hardwareConcurrency != null) {
		scripts.push(
			setNavigatorHardwareConcurrency(fingerprint.hardwareConcurrency),
		);
	}
	if (fingerprint.webglVendor) {
		scripts.push(setWebGLVendor(fingerprint.webglVendor));
	}
	if (fingerprint.webglRenderer) {
		scripts.push(setWebGLRenderer(fingerprint.webglRenderer));
	}
	if (fingerprint.screen) {
		scripts.push(
			setScreenDimensions(fingerprint.screen.width, fingerprint.screen.height),
		);
	}
	if (fingerprint.colorDepth != null) {
		scripts.push(setScreenColorDepth(fingerprint.colorDepth));
	}
	if (fingerprint.availScreen) {
		scripts.push(
			setScreenAvailDimensions(
				fingerprint.availScreen.width,
				fingerprint.availScreen.height,
			),
		);
	}
	if (fingerprint.timezone) {
		scripts.push(setTimezone(fingerprint.timezone));
	}
	if (fingerprint.speechVoices) {
		scripts.push(setSpeechVoices(fingerprint.speechVoices));
	}
	if (fingerprint.webrtcIPv4) {
		scripts.push(setWebRTCIPv4(fingerprint.webrtcIPv4));
	}
	if (fingerprint.webrtcIPv6) {
		scripts.push(setWebRTCIPv6(fingerprint.webrtcIPv6));
	}

	if (scripts.length > 0) {
		await context.addInitScript(scripts.join("\n"));
	}
}
