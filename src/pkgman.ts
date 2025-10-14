import { execSync } from "node:child_process";
import type { PathLike } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import AdmZip from "adm-zip";
import ProgressBar from "progress";
import { CONSTRAINTS } from "./__version__.js";
import {
	CamoufoxNotInstalled,
	FileNotFoundError,
	MissingRelease,
	UnsupportedArchitecture,
	UnsupportedOS,
	UnsupportedVersion,
} from "./exceptions.js";

const ARCH_MAP: { [key: string]: string } = {
	x64: "x86_64",
	ia32: "i686",
	arm64: "arm64",
	arm: "arm64",
};

const OS_MAP: { [key: string]: "mac" | "win" | "lin" } = {
	darwin: "mac",
	linux: "lin",
	win32: "win",
};

if (!(process.platform in OS_MAP)) {
	throw new UnsupportedOS(`OS ${process.platform} is not supported`);
}

export const OS_NAME: "mac" | "win" | "lin" = OS_MAP[process.platform];

export const INSTALL_DIR: PathLike = userCacheDir("camoufox");
export const LOCAL_DATA: PathLike = path.join(
	import.meta.dirname,
	"data-files",
);

export const OS_ARCH_MATRIX: { [key: string]: string[] } = {
	win: ["x86_64", "i686"],
	mac: ["x86_64", "arm64"],
	lin: ["x86_64", "arm64", "i686"],
};

const LAUNCH_FILE: { [key: string]: string } = {
	win: "camoufox.exe",
	mac: "../MacOS/camoufox",
	lin: "camoufox-bin",
};

class Version {
	release: string;
	version?: string;
	sorted_rel: number[];

	constructor(release: string, version?: string) {
		this.release = release;
		this.version = version;
		this.sorted_rel = this.buildSortedRel();
	}

	private buildSortedRel(): number[] {
		const parts = this.release
			.split(".")
			.map((x) =>
				Number.isNaN(Number(x)) ? x.charCodeAt(0) - 1024 : Number(x),
			);
		while (parts.length < 5) {
			parts.push(0);
		}
		return parts;
	}

	get fullString(): string {
		return `${this.version}-${this.release}`;
	}

	equals(other: Version): boolean {
		return this.sorted_rel.join(".") === other.sorted_rel.join(".");
	}

	lessThan(other: Version): boolean {
		for (let i = 0; i < this.sorted_rel.length; i++) {
			if (this.sorted_rel[i] < other.sorted_rel[i]) return true;
			if (this.sorted_rel[i] > other.sorted_rel[i]) return false;
		}
		return false;
	}

	isSupported(): boolean {
		return VERSION_MIN.lessThan(this) && this.lessThan(VERSION_MAX);
	}

	static fromPath(filePath: PathLike = INSTALL_DIR): Version {
		const versionPath = path.join(filePath.toString(), "version.json");
		if (!fs.existsSync(versionPath)) {
			throw new FileNotFoundError(
				`Version information not found at ${versionPath}. Please run \`camoufox fetch\` to install.`,
			);
		}
		const versionData = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
		return new Version(versionData.release, versionData.version);
	}

	static isSupportedPath(path: PathLike): boolean {
		return Version.fromPath(path).isSupported();
	}

	static buildMinMax(): [Version, Version] {
		return [
			new Version(CONSTRAINTS.MIN_VERSION),
			new Version(CONSTRAINTS.MAX_VERSION),
		];
	}
}

const [VERSION_MIN, VERSION_MAX] = Version.buildMinMax();

export class GitHubDownloader {
	githubRepo: string;
	apiUrl: string;

	constructor(githubRepo: string) {
		this.githubRepo = githubRepo;
		this.apiUrl = `https://api.github.com/repos/${githubRepo}/releases`;
	}

	checkAsset(asset: any): any {
		return asset.browser_download_url;
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`Could not find a release asset in ${this.githubRepo}.`,
		);
	}

	async getAsset(
		{ retries }: { retries: number } = { retries: 5 },
	): Promise<any> {
		let attempts = 0;
		let response: Response | undefined;

		while (attempts < retries) {
			try {
				response = await fetch(this.apiUrl);
				if (response.ok) break;
			} catch (e) {
				console.error(e, `retrying (${attempts + 1}/${retries})...`);
				await setTimeout(5e3);
			}
			attempts++;
		}
		if (!response || !response.ok) {
			throw new Error(
				`Failed to fetch releases from ${this.apiUrl} after ${retries} attempts`,
			);
		}

		const releases = await response.json();

		for (const release of releases) {
			for (const asset of release.assets) {
				const data = this.checkAsset(asset);
				if (data) {
					return data;
				}
			}
		}

		this.missingAssetError();
	}
}

export class CamoufoxFetcher extends GitHubDownloader {
	arch: string;
	_version_obj?: Version;
	pattern: RegExp;
	_url?: string;

	constructor() {
		super("daijro/camoufox");
		this.arch = CamoufoxFetcher.getPlatformArch();
		this.pattern = new RegExp(
			`camoufox-(.+)-(.+)-${OS_NAME}\\.${this.arch}\\.zip`,
		);
	}

	async init() {
		await this.fetchLatest();
	}

	checkAsset(asset: any): [Version, string] | null {
		const match = asset.name.match(this.pattern);
		if (!match) return null;

		const version = new Version(match[2], match[1]);
		if (!version.isSupported()) return null;

		return [version, asset.browser_download_url];
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`No matching release found for ${OS_NAME} ${this.arch} in the supported range: (${CONSTRAINTS.asRange()}). Please update the library.`,
		);
	}

	static getPlatformArch(): string {
		const platArch = os.arch().toLowerCase();
		if (!(platArch in ARCH_MAP)) {
			throw new UnsupportedArchitecture(
				`Architecture ${platArch} is not supported`,
			);
		}

		const arch = ARCH_MAP[platArch];
		if (!OS_ARCH_MATRIX[OS_NAME].includes(arch)) {
			throw new UnsupportedArchitecture(
				`Architecture ${arch} is not supported for ${OS_NAME}`,
			);
		}

		return arch;
	}

	async fetchLatest(): Promise<void> {
		if (this._version_obj) return;
		const releaseData = await this.getAsset();
		this._version_obj = releaseData[0];
		this._url = releaseData[1];
	}

	static async downloadFile(url: string): Promise<Buffer> {
		const response = await fetch(url);

		return Buffer.from(await response.arrayBuffer());
	}

	async extractZip(zipFile: string | Buffer): Promise<void> {
		const zip = new AdmZip(zipFile);
		zip.extractAllTo(INSTALL_DIR.toString(), true);
	}

	static cleanup(): boolean {
		if (fs.existsSync(INSTALL_DIR)) {
			fs.rmSync(INSTALL_DIR, { recursive: true });
			return true;
		}
		return false;
	}

	setVersion(): void {
		fs.writeFileSync(
			path.join(INSTALL_DIR.toString(), "version.json"),
			JSON.stringify({ version: this.version, release: this.release }),
		);
	}

	async install(): Promise<void> {
		await this.init();
		await CamoufoxFetcher.cleanup();
		try {
			fs.mkdirSync(INSTALL_DIR, { recursive: true });

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-"));
			const tempFilePath = path.join(tempDir, "camoufox.zip");
			const tempFileStream = fs.createWriteStream(tempFilePath);

			await webdl(this.url, "Downloading Camoufox...", true, tempFileStream);
			await new Promise((r) => tempFileStream.close(r));

			await this.extractZip(tempFilePath);
			this.setVersion();

			if (OS_NAME !== "win") {
				execSync(`chmod -R 755 ${INSTALL_DIR}`);
			}

			console.log("Camoufox successfully installed.");
		} catch (e) {
			console.error(`Error installing Camoufox: ${e}`);
			await CamoufoxFetcher.cleanup();
			throw e;
		}
	}

	get url(): string {
		if (!this._url) {
			throw new Error(
				"Url is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._url;
	}

	get version(): string {
		if (!this._version_obj || !this._version_obj.version) {
			throw new Error(
				"Version is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._version_obj.version;
	}

	get release(): string {
		if (!this._version_obj) {
			throw new Error(
				"Release information is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.release;
	}

	get verstr(): string {
		if (!this._version_obj) {
			throw new Error(
				"Version is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.fullString;
	}
}

function userCacheDir(appName: string): string {
	if (OS_NAME === "win") {
		return path.join(
			os.homedir(),
			"AppData",
			"Local",
			appName,
			appName,
			"Cache",
		);
	} else if (OS_NAME === "mac") {
		return path.join(os.homedir(), "Library", "Caches", appName);
	} else {
		return path.join(os.homedir(), ".cache", appName);
	}
}

export function installedVerStr(): string {
	return Version.fromPath().fullString;
}

export function camoufoxPath(downloadIfMissing: boolean = true): PathLike {
	// Ensure the directory exists and is not empty
	if (!fs.existsSync(INSTALL_DIR) || fs.readdirSync(INSTALL_DIR).length === 0) {
		if (!downloadIfMissing) {
			throw new Error(`Camoufox executable not found at ${INSTALL_DIR}`);
		}
	} else if (
		fs.existsSync(INSTALL_DIR) &&
		Version.isSupportedPath(INSTALL_DIR)
	) {
		return INSTALL_DIR;
	} else {
		if (!downloadIfMissing) {
			throw new UnsupportedVersion("Camoufox executable is outdated.");
		}
	}

	// Install and recheck
	const fetcher = new CamoufoxFetcher();
	fetcher.install().then(() => camoufoxPath());
	return INSTALL_DIR;
}

export function getPath(file: string): string {
	if (OS_NAME === "mac") {
		return path.resolve(
			camoufoxPath().toString(),
			"Camoufox.app",
			"Contents",
			"Resources",
			file,
		);
	}
	return path.join(camoufoxPath().toString(), file);
}

export function launchPath(): string {
	const launchPath = getPath(LAUNCH_FILE[OS_NAME]);
	if (!fs.existsSync(launchPath)) {
		throw new CamoufoxNotInstalled(
			`Camoufox is not installed at ${camoufoxPath()}. Please run \`camoufox fetch\` to install.`,
		);
	}
	return launchPath;
}

export async function webdl(
	url: string,
	desc: string = "",
	bar: boolean = true,
	buffer: Writable | null = null,
	{ retries }: { retries: number } = { retries: 5 },
): Promise<Buffer> {
	let attempts = 0;
	let response: Response | undefined;

	while (attempts < retries) {
		try {
			response = await fetch(url);
			if (response.ok) break;
		} catch (e) {
			console.error(e, `retrying (${attempts + 1}/${retries})...`);
			await setTimeout(5e3);
		}
		attempts++;
	}

	if (!response || !response.ok) {
		throw new Error(`Failed to download from ${url} after ${retries} attempts`);
	}

	const totalSize = parseInt(response.headers.get("content-length") || "0", 10);
	const progressBar = bar
		? new ProgressBar(`${desc} [:bar] :percent :etas`, {
				total: totalSize,
				width: 40,
			})
		: null;

	const chunks: Uint8Array[] = [];
	for await (const chunk of response.body!) {
		if (buffer) {
			buffer.write(chunk);
		} else {
			chunks.push(chunk);
		}
		if (progressBar) {
			progressBar.tick(chunk.length, "X");
		}
	}

	const fileBuffer = Buffer.concat(chunks);
	return fileBuffer;
}

export async function unzip(
	zipFile: Buffer,
	extractPath: string,
	desc?: string,
	bar: boolean = true,
): Promise<void> {
	const zip = new AdmZip(zipFile);
	const zipEntries = zip.getEntries();

	if (bar) {
		console.log(desc || "Extracting files...");
	}

	for (const entry of zipEntries) {
		if (bar) {
			console.log(`Extracting ${entry.entryName}`);
		}
		zip.extractEntryTo(entry, extractPath, false, true);
	}

	if (bar) {
		console.log("Extraction complete.");
	}
}
