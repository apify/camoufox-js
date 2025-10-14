import { type BrowserServer, firefox } from "playwright-core";
import { type LaunchOptions, launchOptions } from "./utils.js";

export async function launchServer({
	port,
	ws_path,
	...options
}:
	| LaunchOptions
	| { port?: number; ws_path?: string }): Promise<BrowserServer> {
	return firefox.launchServer({
		...(await launchOptions(options)),
		port,
		wsPath: ws_path,
	});
}
