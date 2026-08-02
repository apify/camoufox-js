import {
	type Browser,
	type BrowserContext,
	type BrowserType,
	firefox,
} from "playwright-core";

import {
	attachNoViewportDefault,
	type LaunchOptions,
	launchOptions,
	spoofsWindowDimensions,
	syncAttachVD,
	cleanStaleLockFiles,
} from "./utils.js";
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

	const noViewportDefault = spoofsWindowDimensions(fromOptions);

	if (typeof userDataDir === "string") {
		if (noViewportDefault && !("viewport" in fromOptions)) {
			fromOptions = { ...fromOptions, viewport: null };
		}
		// Clean up stale lock files from previous crashed sessions
		cleanStaleLockFiles(userDataDir);
		const context = await playwright.launchPersistentContext(
			userDataDir,
			fromOptions,
		);
		return syncAttachVD(context, virtualDisplay);
	}

	const browser = await playwright.launch(fromOptions);
	if (noViewportDefault) {
		attachNoViewportDefault(browser);
	}
	return syncAttachVD(browser, virtualDisplay);
}
