# Upstream and local modifications

This directory is a vendored copy of [jfo8000/ScratchJr-Desktop](https://github.com/jfo8000/ScratchJr-Desktop),
the open-source community port of MIT's ScratchJr.

- Upstream commit: `919482d724904a560d6c77dab06240341584c502` ("Update index.html", 2020-11-22)
- Upstream licence: MIT (see `LICENSE`)

The `.git` directory of the upstream clone was removed so that these files are tracked by the
ScratchJR-MCP repository itself. To compare against upstream again:

```sh
git clone https://github.com/jfo8000/ScratchJr-Desktop.git /tmp/sjr-upstream
diff -ru /tmp/sjr-upstream desktop --exclude node_modules --exclude .git --exclude out
```

## What was changed

Every change is listed here so the fork stays easy to re-apply to a newer upstream.

### `src/branding.js` (new file)

Holds the product name, version, installer name and MCP debug port. Renaming the fork is a
one-file change; nothing else hardcodes the name.

### `src/main.js`

1. Requires `./branding`.
2. Opens the Chrome DevTools Protocol on `127.0.0.1:<mcpDebugPort>` (9223 by default) before the
   app becomes ready. This is what lets the ScratchJR MCP server attach to a window the user
   opened themselves, instead of only to one the server launched.
3. Honours `SCRATCHJR_DOCUMENTS` as an override for the Documents root, so a test build cannot
   write into the projects of an installed copy.
4. Only opens DevTools when the MCP port is disabled or `SCRATCHJR_DEVTOOLS=1` is set. DevTools
   occupies the page's single debugger slot, which would otherwise lock the MCP server out.
5. Sets the window title from `branding.windowTitle` and keeps it there when a page changes its
   own `<title>`.

### `src/app/settings.json`

Adds `buildName` and `buildVersion`, which the MCP `scratchjr_status` tool reports.

`scratchJrVersion` is deliberately left at `iOSv01`: the lobby query in `src/main.js` filters
saved projects on that exact value, so changing it would hide every project a child has saved.

### `src/app/*.html`

`<title>` updated on `index.html`, `home.html`, `editor.html` and `gettingstarted.html`.

### `package.json` and `forge.config.js`

Product name, version, author and the Squirrel installer identity. `forge.config.js` reads them
from `src/branding.js`.

Note that the Squirrel installer name (`ScratchJR-Modified-KerneilGocotano`) cannot match the
displayed product name: Squirrel treats it as a NuGet package id, which allows only letters,
digits, dots, dashes and underscores. It also decides the install path,
`%LOCALAPPDATA%\ScratchJR-Modified-KerneilGocotano\app-<version>\ScratchJr.exe`.

## Trademark note

MIT's `TRADEMARKS` policy in this directory allows the ScratchJr marks only on a substantially
unmodified build. A build that adds features — such as the MCP bridge — is expected to drop the
marks and use its own name. That matters for public redistribution rather than for a local
build; change `productName` in `src/branding.js` if you intend to publish this.
