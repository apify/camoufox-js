import { describe, expect, test } from 'vitest';
import { Camoufox } from '../src';

const TEST_CASES = [
    { os: 'linux', userAgentRegex: /Linux/i },
    { os: 'windows', userAgentRegex: /Windows/i },
    { os: 'macos', userAgentRegex: /Mac OS/i },
];

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
