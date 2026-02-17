import { type BrowserServer, firefox } from "playwright-core";
import { type LaunchOptions, launchOptions } from "./utils.js";

export async function launchServer({
	port,
	ws_path,
	...options
}:
	| LaunchOptions
	| { port?: number; ws_path?: string }): Promise<BrowserServer> {
	// Extract and normalize headless (virtual is treated as true for server mode)
	const { headless, ...restOptions } = options as LaunchOptions;
	const normalizedHeadless: boolean | undefined =
		headless === "virtual" ? true : headless;

	return firefox.launchServer({
		...(await launchOptions({ ...restOptions, headless: normalizedHeadless })),
		port,
		wsPath: ws_path,
	});
}
