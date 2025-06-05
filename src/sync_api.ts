import {
    Browser,
    BrowserContext,
    BrowserType,
    firefox
} from 'playwright-core';

import { LaunchOptions, launchOptions, syncAttachVD } from './utils.js';
import { VirtualDisplay } from './virtdisplay.js';

export async function Camoufox(launch_options: LaunchOptions | { headless?: boolean | 'virtual' }) {
    const { headless, ...launchOptions } = launch_options;
    return NewBrowser(firefox, headless, {}, false, false, launchOptions);
}

export async function NewBrowser(
    playwright: BrowserType<Browser>,
    headless: boolean | 'virtual' = false,
    fromOptions: Record<string, any> = {},
    persistentContext: boolean = false,
    debug: boolean = false,
    launch_options: LaunchOptions = {}
): Promise<Browser | BrowserContext> {
    let virtualDisplay: VirtualDisplay | null = null;

    if (headless === 'virtual') {
        virtualDisplay = new VirtualDisplay(debug);
        launch_options['virtual_display'] = virtualDisplay.get();
        launch_options.headless = false;
    } else {
        launch_options.headless ||= headless;
    }

    if (!fromOptions || Object.keys(fromOptions).length === 0) {
        fromOptions = await launchOptions({ debug, ...launch_options });
    }

    if (persistentContext) {
        const context = await playwright.launchPersistentContext('~/.crawlee/persistent-user-data-dir', fromOptions);
        return syncAttachVD(context, virtualDisplay);
    }

    const browser = await playwright.launch(fromOptions);
    return syncAttachVD(browser, virtualDisplay);
}
