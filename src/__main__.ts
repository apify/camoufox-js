#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { Command } from "commander";
import { DefaultAddons, maybeDownloadAddons } from "./addons.js";
import { ALLOW_GEOIP, downloadMMDB, removeMMDB } from "./locale.js";
import { CamoufoxFetcher, INSTALL_DIR, installedVerStr } from "./pkgman.js";
import { launchServer } from "./server.js";
import { Camoufox } from "./sync_api.js";
import { getAsBooleanFromENV } from "./utils.js";

class CamoufoxUpdate extends CamoufoxFetcher {
	currentVerStr: string | null;

	private constructor() {
		super();
		this.currentVerStr = null;
		try {
			this.currentVerStr = installedVerStr();
		} catch (error) {
			if (error instanceof Error && error.name === "FileNotFoundError") {
				this.currentVerStr = null;
			} else {
				throw error;
			}
		}
	}

	static async create(): Promise<CamoufoxUpdate> {
		const updater = new CamoufoxUpdate();
		await updater.init();
		return updater;
	}

	isUpdateNeeded(): boolean {
		if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
			console.log(
				"Skipping browser download / update check due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set!",
			);
			return false;
		}

		return this.currentVerStr === null || this.currentVerStr !== this.verstr;
	}

	async update(): Promise<void> {
		if (!this.isUpdateNeeded()) {
			console.log("Camoufox binaries up to date!");
			console.log(`Current version: v${this.currentVerStr}`);
			return;
		}

		if (this.currentVerStr !== null) {
			console.log(
				`Updating Camoufox binaries from v${this.currentVerStr} => v${this.verstr}`,
				"yellow",
			);
		} else {
			console.log(`Fetching Camoufox binaries...`);
		}
		await this.install();
	}

	async cleanup(): Promise<boolean> {
		if (!existsSync(INSTALL_DIR)) {
			return false;
		}
		await rmSync(INSTALL_DIR, { recursive: true, force: true });
		console.log("Camoufox binaries removed!");
		return true;
	}
}

const program = new Command();

program.command("fetch").action(async () => {
	const updater = await CamoufoxUpdate.create();
	await updater.update();
	if (ALLOW_GEOIP) {
		downloadMMDB();
	}
	maybeDownloadAddons(DefaultAddons);
});

program.command("remove").action(async () => {
	const updater = await CamoufoxUpdate.create();
	if (!(await updater.cleanup())) {
		console.log("Camoufox binaries not found!", "red");
	}
	removeMMDB();
});

program
	.command("test")
	.argument("[url]", "URL to open", null)
	.action(async (url) => {
		const browser = await Camoufox({
			headless: false,
			env: process.env as Record<string, string>,
			config: { showcursor: true },
			humanize: 0.5,
			geoip: true,
		});
		const page = await browser.newPage();
		if (url) {
			await page.goto(url);
		}
		await page.pause();
	});

program.command("server").action(async () => {
	const server = await launchServer({});

	console.log(`Camoufox server started at ${server.wsEndpoint()}`);
	console.log();
	console.log(
		`You can connect to it using Playwright's BrowserType.connect() method.`,
	);
	console.log(`To stop the server, press Ctrl+C or close this terminal.`);
});

program.command("path").action(() => {
	console.log(INSTALL_DIR);
});

program.command("version").action(async () => {
	try {
		const pkgVersion = require("pkg-version");
		console.log(`Pip package:\tv${pkgVersion("camoufox")}`);
	} catch (_error) {
		console.log("Pip package:\tNot installed!", "red");
	}

	const updater = await CamoufoxUpdate.create();
	const binVer = updater.currentVerStr;

	if (!binVer) {
		console.log("Camoufox:\tNot downloaded!", "red");
		return;
	}
	console.log(`Camoufox:\tv${binVer} `, "green", false);

	if (updater.isUpdateNeeded()) {
		console.log(`(Latest supported: v${updater.verstr})`, "red");
	} else {
		console.log("(Up to date!)", "yellow");
	}
});

program.parse(process.argv);
