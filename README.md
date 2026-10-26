# camoufox-js

**This package is deprecated.** Camoufox now has an official TypeScript launcher, published to npm as [`camoufox`](https://www.npmjs.com/package/camoufox) from [daijro/camoufox](https://github.com/daijro/camoufox/tree/main/typescript). `camoufox-js` only re-exports that package, and the `camoufox-js` binary relays every command to the official `camoufox` CLI. Please switch to it directly:

```bash
npm uninstall camoufox-js
npm install camoufox
npx camoufox fetch
```

```javascript
import { launchOptions } from 'camoufox';
import { PlaywrightCrawler } from 'crawlee';
import { firefox } from 'playwright';

const crawler = new PlaywrightCrawler({
    browserPoolOptions: { useFingerprints: false },
    launchContext: {
        launcher: firefox,
        launchOptions: await launchOptions({ headless: true }),
    },
});
```

The official package exposes a superset of the `camoufox-js` 0.13 API, but a few things changed. `NewBrowser()` takes an options object instead of positional arguments: `NewBrowser(firefox, { headless, from_options, user_data_dir, debug, ...launchOptions })`. The `proxy` option has to be a Playwright proxy object (`{ server, username, password }`), proxy URL strings are no longer converted. The `fingerprint` option takes an [fpgen](https://github.com/scrapfly/fingerprint-generator) fingerprint instead of a `fingerprint-generator` one; see also the new `fingerprint_preset` option and `NewContext()`. The legacy `allow_webgl: false` alias is gone, use `block_webgl: true`.

The browser is still installed into the per-user cache directory (`$XDG_CACHE_HOME/camoufox` or `~/.cache/camoufox` on Linux), but `CAMOUFOX_INSTALL_DIR` is no longer supported, and neither is `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`: `launchOptions()` downloads the browser build the installed `camoufox` release is paired with on first use. Set `CAMOUFOX_EXECUTABLE_PATH` (or the `executable_path` option) to launch a specific binary without any download, or use `npx camoufox set` to choose one of the installed builds. Builds installed by `camoufox-js` 0.13 stay in the shared cache and can be removed with `npx camoufox remove --select`.

See https://camoufox.com/ or https://github.com/daijro/camoufox for more information on Camoufox.
