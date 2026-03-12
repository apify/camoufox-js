export { DefaultAddons } from "./addons.js";
export {
	type ContextFingerprint,
	applyContextFingerprint,
	setAudioFingerprintSeed,
	setCanvasSeed,
	setFontList,
	setFontSpacingSeed,
	setNavigatorHardwareConcurrency,
	setNavigatorOscpu,
	setNavigatorPlatform,
	setScreenColorDepth,
	setScreenDimensions,
	setSpeechVoices,
	setTimezone,
	setWebGLRenderer,
	setWebGLVendor,
	setWebRTCIPv4,
	setWebRTCIPv6,
} from "./context.js";
export { launchServer } from "./server.js";
export { Camoufox, NewBrowser } from "./sync_api.js";
export { type LaunchOptions, launchOptions } from "./utils.js";
