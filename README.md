# camoufox-js

This is the JavaScript client for Camoufox. It is a port of the Python wrapper (doesn't call the original Python scripts).

## Installation

```bash
npm install camoufox-js
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
    launchOptions: await launchOptions({ /* Camoufox options */ }),
    // other Playwright options
});
            
const page = await browser.newPage(); // `page` is a Playwright Page instance
```

## More info

See https://camoufox.com/ or https://github.com/daijro/camoufox for more information on Camoufox.


