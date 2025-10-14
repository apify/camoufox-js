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
	launch_options:
		| LaunchOptions
		| { headless?: boolean | "virtual"; user_data_dir: UserDataDir } = {},
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

	if (headless === "virtual") {
		virtualDisplay = new VirtualDisplay(debug);
		launch_options.virtual_display = virtualDisplay.get();
		launch_options.headless = false;
	} else {
		launch_options.headless ||= headless;
	}

	if (!fromOptions || Object.keys(fromOptions).length === 0) {
		fromOptions = await launchOptions({ debug, ...launch_options });
	}

	if (typeof userDataDir === "string") {
		const context = await playwright.launchPersistentContext(
			userDataDir,
			fromOptions,
		);
		return syncAttachVD(context, virtualDisplay);
	}

	const browser = await playwright.launch(fromOptions);
	return syncAttachVD(browser, virtualDisplay);
}
