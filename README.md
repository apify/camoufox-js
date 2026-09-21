# camoufox-js

This is the JavaScript client for Camoufox. It is a port of the Python wrapper (doesn't call the original Python scripts).

## Installation

```bash
npm install camoufox-js
```

The Camoufox browser itself is downloaded with `npx camoufox-js fetch` (see
[Managing Camoufox versions](#managing-camoufox-versions)) into the per-user cache directory (`$XDG_CACHE_HOME/camoufox` or `~/.cache/camoufox` on Linux). Set the
`CAMOUFOX_INSTALL_DIR` environment variable to install and resolve it from a
custom location instead — useful in containers and CI images where the home
directory is ephemeral or persisted separately (similar to Playwright's
`PLAYWRIGHT_BROWSERS_PATH`):

```bash
CAMOUFOX_INSTALL_DIR=/opt/camoufox npx camoufox-js fetch
```

## Managing Camoufox versions

The CLI mirrors the [Python package manager](https://github.com/daijro/camoufox/tree/main/pythonlib#installing-multiple-camoufox-versions--from-other-repos):
browsers are installed side by side under `<install dir>/browsers/<repo>/<version>-<build>-<sha8>`, and
a small `config.json` decides which one is active. The layout is the same as the Python library's, so the
two can share an install directory.

```
$ npx camoufox-js --help

Commands:
  sync [options]                   Sync available versions from remote repositories
  fetch [options] [version]        Install the active version, or a specific version
  set [specifier]                  Set the active Camoufox version to use & fetch
  active                           Print the current active version
  list [options] [mode]            List Camoufox versions
  remove [options] [version_path]  Remove downloaded data
  test [options] [url]             Open the Playwright inspector
  server                           Launch a Playwright server
  path                             Print the install directory path
  version                          Display version, package, browser, and storage info
```

### `sync`

Pull the list of release assets from GitHub into `repo_cache.json`. `fetch` does this automatically.

```bash
npx camoufox-js sync
npx camoufox-js sync --spoof-os lin --spoof-arch arm64   # catalog for another platform
```

### `set`

Choose a channel to follow, or pin a specific version. Without a specifier an interactive selector opens.

```bash
npx camoufox-js set official/stable                    # default: latest stable release from the official repo
npx camoufox-js set official/prerelease                # follow prereleases
npx camoufox-js set official/stable/134.0.2-beta.20    # pin a specific version
npx camoufox-js set coryking/stable                    # follow another repository
```

### `active`

Print what `fetch` will install and whether it is on disk:

```bash
$ npx camoufox-js active
official/stable/135.0.1-beta.24 (8020db3b)
```

### `fetch`

Install the pinned version, or the latest version in the active channel (`official/stable` by default).
Downloads are verified against the sha256 digest GitHub publishes for the asset.

```bash
npx camoufox-js fetch                                   # install the active version
npx camoufox-js fetch official/stable/135.0-beta.25     # install a specific version without pinning it
npx camoufox-js fetch --replace                         # reinstall the active version
```

Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to skip the download and use whatever is already installed
(for example in a container image built with a prior `fetch`).

### `list`

```bash
npx camoufox-js list          # installed versions
npx camoufox-js list all      # everything from the synced repos
npx camoufox-js list --path   # include install paths
```

### `remove`

```bash
npx camoufox-js remove -y                              # remove the whole install directory
npx camoufox-js remove official/stable/134.0.2-beta.20  # remove one version
npx camoufox-js remove --select                        # pick a version interactively
```

### `version`

Show the package versions, the active browser, whether it is the latest in its channel, and where
everything is stored.

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


