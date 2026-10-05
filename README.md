# camoufox-js

This is the JavaScript client for Camoufox. It is a port of the Python wrapper (doesn't call the original Python scripts).

## Installation

```bash
npm install camoufox-js
```

The Camoufox browser itself is downloaded with `npx camoufox-js fetch` into the
per-user cache directory (`$XDG_CACHE_HOME/camoufox` or `~/.cache/camoufox` on Linux). Set the
`CAMOUFOX_INSTALL_DIR` environment variable to install and resolve it from a
custom location instead — useful in containers and CI images where the home
directory is ephemeral or persisted separately (similar to Playwright's
`PLAYWRIGHT_BROWSERS_PATH`):

```bash
CAMOUFOX_INSTALL_DIR=/opt/camoufox npx camoufox-js fetch
```

Each camoufox-js release is tested with one Camoufox build (`src/data-files/browser-pin.json`), and `fetch` installs
exactly that build into `browsers/<repo>/<version>-<build>/` inside that directory. This is the layout the Python
library uses, so both can share one cache. If the build is missing, the first launch downloads it, unless
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set.

Other builds can be chosen with the same commands as in the
[Python library](https://github.com/daijro/camoufox/tree/main/pythonlib#fetch), limited to the builds this release
supports:

```bash
npx camoufox-js sync                                     # refresh the list of available builds
npx camoufox-js list all                                 # show them (`list` shows installed ones)
npx camoufox-js set official/stable                      # follow the latest stable build
npx camoufox-js set official/stable/152.0.4-beta.30      # or pin one
npx camoufox-js fetch                                    # install the chosen build
npx camoufox-js active                                   # print the build launches use
npx camoufox-js set --release                            # go back to the build this release is tested with
npx camoufox-js remove official/stable/152.0.4-beta.30   # remove one build (`remove` removes everything)
```

## Usage 

You can launch Playwright-controlled Camoufox using this package like this:

```javascript
import { Camoufox } from 'camoufox-js';

// you might need to run `npx camoufox-js fetch` to download the browser after installing the package

const browser = await Camoufox({
    // custom camoufox options
});
            
const page = await browser.newPage(); // `page` is a Playwright Page instance
```

Alternatively, if you want to use additional Playwright launch options, you can launch the Camoufox instance like this:

```javascript
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';

// you might need to run `npx camoufox-js fetch` to download the browser after installing the package

const browser = await firefox.launch({
    ...await launchOptions({ /* Camoufox options */ }),
    // other Playwright options, overriding the Camoufox options
});
            
const page = await browser.newPage(); // `page` is a Playwright Page instance
```

### Launching a Camoufox server

Camoufox can be ran as a remote websocket server. It can be accessed from other devices, and languages other than Python supporting the Playwright API.

```javascript
import { launchServer } from 'camoufox-js';
import { firefox } from 'playwright-core';

// you might need to run `npx camoufox-js fetch` to download the browser after installing the package

const server = await launchServer({ port: 8888, ws_path: '/camoufox' });
const browser = await firefox.connect(server.wsEndpoint());

const page = await browser.newPage();

// ...
// Use your browser instance as usual
// ...

await browser.close();  
await server.close(); // Close the server when done
```

## More info

See https://camoufox.com/ or https://github.com/daijro/camoufox for more information on Camoufox.


