import {
	type Browser,
	type BrowserContext,
	type BrowserType,
	firefox,
} from "playwright-core";

import { type LaunchOptions, launchOptions, syncAttachVD } from "./utils.js";
import { VirtualDisplay } from "./virtdisplay.js";

export async function Camoufox<
	UserDataDir extends string | undefined = undefined,
	ReturnType = UserDataDir extends string ? BrowserContext : Browser,
>(
	launch_options: LaunchOptions & { user_data_dir?: UserDataDir } = {},
): Promise<ReturnType> {
	const { headless, user_data_dir, ...launchOptions } = launch_options;
	return NewBrowser(
		firefox,
		headless,
		{},
		user_data_dir ?? false,
		false,
		launchOptions,
	);
}

export async function NewBrowser<
	UserDataDir extends string | false = false,
	ReturnType = UserDataDir extends string ? BrowserContext : Browser,
>(
	playwright: BrowserType<Browser>,
	headless: boolean | "virtual" = false,
	fromOptions: Record<string, any> = {},
	userDataDir: UserDataDir = false as UserDataDir,
	debug: boolean = false,
	launch_options: LaunchOptions = {},
): Promise<ReturnType> {
	let virtualDisplay: VirtualDisplay | null = null;

	// Normalize headless to boolean and prepare options for launchOptions function
	const normalizedHeadless: boolean =
		headless === "virtual" ? false : headless || false;

	if (headless === "virtual") {
		virtualDisplay = new VirtualDisplay(debug);
		launch_options.virtual_display = await virtualDisplay.get();
	}

	if (!fromOptions || Object.keys(fromOptions).length === 0) {
		fromOptions = await launchOptions({
			debug,
			...launch_options,
			headless: normalizedHeadless,
		});
	}

	if (typeof userDataDir === "string") {
		const context = await playwright.launchPersistentContext(
			userDataDir,
			fromOptions,
		);
		return syncAttachVD(context, virtualDisplay);
	}

	const browser = await playwright.launch(fromOptions);

	// Fix: Strip isMobile from Browser.setDefaultViewport CDP call
	// Playwright 1.61+ sends isMobile which Camoufox's Firefox doesn't recognize
	// See https://github.com/apify/camoufox-js/issues/299
	if (browser && (browser as any)._connection) {
		const conn = (browser as any)._connection;
		const origSend = conn.sendMessageToServer.bind(conn);
		conn.sendMessageToServer = async (msg: string) => {
			try {
				const parsed = JSON.parse(msg);
				if (parsed.method === "Browser.setDefaultViewport" && parsed.params?.viewport?.isMobile !== undefined) {
					const { isMobile, ...cleanViewport } = parsed.params.viewport;
					parsed.params.viewport = cleanViewport;
					return origSend(JSON.stringify(parsed));
				}
			} catch {}
			return origSend(msg);
		};
	}
	return syncAttachVD(browser, virtualDisplay);
}
