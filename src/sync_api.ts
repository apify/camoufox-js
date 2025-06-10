import type { Browser, BrowserContext, BrowserType } from "playwright-core";
import { firefox } from "playwright-core";

import type { LaunchOptions } from "./utils.js";
import { launchOptions as getLaunchOptions, syncAttachVD } from "./utils.js";
import { VirtualDisplay } from "./virtdisplay.js";

export async function Camoufox(
  launch_options: LaunchOptions | { headless?: boolean | "virtual" },
) {
  const { headless, ...rest } = launch_options;
  return NewBrowser(firefox, headless, {}, false, false, rest);
}

export async function NewBrowser(
  playwright: BrowserType<Browser>,
  headless: boolean | "virtual" = false,
  pw_launch_options: Record<string, any> = {},
  persistentContext = false,
  debug = false,
  camoufox_options: LaunchOptions = {},
): Promise<Browser | BrowserContext> {
  let virtualDisplay: VirtualDisplay | null = null;

  const camoufoxOptions = { ...camoufox_options };

  if (headless === "virtual") {
    virtualDisplay = new VirtualDisplay(debug);
    camoufoxOptions.virtual_display = virtualDisplay.get();
    camoufoxOptions.headless = false;
  } else {
    camoufoxOptions.headless ||= headless;
  }

  let launchOptions = { ...pw_launch_options };
  if (!launchOptions || Object.keys(launchOptions).length === 0) {
    launchOptions = await getLaunchOptions({ debug, ...camoufoxOptions });
  }

  if (persistentContext) {
    const context = await playwright.launchPersistentContext(
      "~/.crawlee/persistent-user-data-dir",
      launchOptions,
    );
    return syncAttachVD(context, virtualDisplay);
  }

  const browser = await playwright.launch(launchOptions);
  return syncAttachVD(browser, virtualDisplay);
}
