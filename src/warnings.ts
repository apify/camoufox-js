import { join } from 'path';
import { loadYaml } from './pkgman.js';

const WARNINGS_DATA = loadYaml(join(import.meta.dirname, 'data-files', 'warnings.yml'));

export class LeakWarning extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LeakWarning';
    }

    static warn(warningKey: string, iKnowWhatImDoing?: boolean): void {
        let warning = WARNINGS_DATA[warningKey];
        if (iKnowWhatImDoing) {
            return;
        }
        if (iKnowWhatImDoing !== undefined) {
            warning += '\nIf this is intentional, pass `iKnowWhatImDoing=true`.';
        }

        const currentModule = import.meta.dirname;
        const originalStackTrace = Error.prepareStackTrace;
        Error.prepareStackTrace = (_, stack) => stack;
        const err = new Error();
        const stack = err.stack as unknown as NodeJS.CallSite[];
        Error.prepareStackTrace = originalStackTrace;

        for (const frame of stack) {
            const frameFileName = frame.getFileName();
            if (frameFileName && !frameFileName.startsWith(currentModule)) {
                console.warn(`${warning} at ${frameFileName}:${frame.getLineNumber()}`);
                return;
            }
        }

        console.warn(warning);
    }
}