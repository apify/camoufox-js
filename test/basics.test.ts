import { describe, expect, test } from 'vitest';
import { playwright, Camoufox, launchServer } from '../src';

const TEST_CASES = [
    { os: 'linux', userAgentRegex: /Linux/i },
    { os: 'windows', userAgentRegex: /Windows/i },
    { os: 'macos', userAgentRegex: /Mac OS/i },
];

describe('virtual display', () => {
    test('should launch', async () => {
        const browser = await Camoufox({
            os: 'linux',
            headless: 'virtual',
        } as any);

        const page = await browser.newPage();
        await page.goto('http://httpbin.org/user-agent');
        const userAgent = await page.evaluate(() => navigator.userAgent.toString());
        expect(userAgent).toMatch(/Linux/i);
        await browser.close();

    }, 10e3);
});

describe('Fingerprint consistency', () => {
    test.each(TEST_CASES)('User-Agent matches set OS ($os)',
        async ({os, userAgentRegex}) => {
            const browser = await Camoufox({
                os,
                headless: true,
            } as any);

            const page = await browser.newPage();

            await page.goto('http://httpbin.org/user-agent');

            const [httpAgent, jsAgent] = await page.evaluate(() => {
                return [
                    JSON.parse(document.body.innerText)['user-agent'],
                    navigator.userAgent.toString(),
                ]
            });

            expect(httpAgent).toEqual(jsAgent);
            expect(httpAgent).toMatch(userAgentRegex);

            TEST_CASES.forEach(({ os: testOs, userAgentRegex }) => {
                if (testOs !== os) {
                    expect(httpAgent).not.toMatch(userAgentRegex);
                }
            });

            await browser.close();
        },
        10e3
    );
});

test('Playwright connects to Camoufox server', async () => {
    const server = await launchServer({
        headless: true,
    });

    const browser = await playwright.firefox.connect(server.wsEndpoint());
    const page = await browser.newPage();
    await page.goto('http://httpbin.org/user-agent');

    const userAgent = await page.evaluate(() => navigator.userAgent.toString());
    expect(userAgent).toMatch(/Firefox/);
    await browser.close();

    await server.close();
}, 30e3);
