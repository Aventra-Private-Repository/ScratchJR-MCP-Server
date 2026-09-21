# Title: ScratchJr Desktop MCP Server

## Description:

Create, edit, run, and inspect real ScratchJr Desktop projects through an MCP client such as Claude, Codex, Cursor, or Google Antigravity. This server controls the installed application through a local Electron connection and saves through ScratchJr's own database interface.

Use natural-language requests to build interactive stories, animations, and simple games with characters, backgrounds, text, sounds, and programming blocks. The server also provides screenshots, custom SVG artwork, and automatic database backups.

**Already set up on this PC:** ScratchJr Desktop and the server dependencies are installed; `scratchjr` is registered with Codex and Claude Code; Claude Desktop's configuration is written. Claude Code's connection check passed. Restart Claude or start a new Codex session to load the tools. The installation steps below are for setting up another PC or reinstalling this project.

## Requirements:

| Requirement | Details |
| --- | --- |
| Operating system | Windows with PowerShell; this integration was tested on Windows |
| ScratchJr | ScratchJr Desktop community port, tested with version 1.3.2 |
| Node.js and npm | Node.js 22 or newer; tested with Node 24. npm is used to install server dependencies |
| AI client | Claude Desktop, Claude Code, Codex, Cursor, or Google Antigravity with local MCP support; run the client on the same Windows PC as ScratchJr |
| CLI registration | Install the Claude Code or Codex CLI and make it available on PATH if you want the setup script to register that client automatically. Claude Desktop setup does not require these CLIs |
| Project files | This repository, including `package.json`, `package-lock.json`, `src/`, and `scripts/` |
| Internet access | Needed to download software, install npm dependencies, and use your AI client |
| Local storage | Write access to ScratchJr's Documents folder and this server's `backups/` and `artifacts/` folders |

This integration controls ScratchJr Desktop. The tablet version and Scratch 3 use different integrations.

## Installation Setup:

### 1. Install and initialize ScratchJr Desktop

1. Open the [ScratchJr Desktop download page](https://jfo8000.github.io/ScratchJr-Desktop/) and select the Windows installer. This is the community desktop port.
2. Run the installer, then launch ScratchJr Desktop.
3. Create a small project, return to the project library to save it, and close ScratchJr.
4. Confirm the database exists at `C:\Users\SkieHackerYT\Documents\ScratchJR\scratchjr.sqllite`. On another PC, replace `SkieHackerYT` with that Windows account's name. The desktop port stores its projects in this Documents folder. See the [desktop project's storage documentation](https://jfo8000.github.io/ScratchJr-Desktop/#wheres-the-data).

The server automatically looks for the versioned executable under `%LOCALAPPDATA%\ScratchJr\app-*\ScratchJr.exe`. For a custom installation or redirected Documents folder, configure `SCRATCHJR_EXE` or `SCRATCHJR_DATABASE` as described below.

### 2. Prepare the local assets folder

Use this folder to organize custom source artwork:

```text
C:\Users\SkieHackerYT\Documents\ScratchJr\_Assets
```

Create it if it does not already exist:

```powershell
New-Item -ItemType Directory -Path 'C:\Users\SkieHackerYT\Documents\ScratchJr\_Assets' -Force
```

Keep custom SVG characters and backgrounds here. This is a source-artwork folder: the MCP server does **not** automatically scan or import its files. To use an SVG, read it using the AI client's file-access tools, or paste its contents into the chat, and ask the assistant to register it with `scratchjr_add_svg_asset`. That tool accepts SVG markup, a name, a kind (`character` or `background`), width, and height. Use static SVG geometry; backgrounds should be 480 by 360 pixels. Use the returned `md5` filename when creating a character or choosing a background.

Registered artwork is saved inside ScratchJr's database and can be discovered with `scratchjr_list_assets`. Simply placing PNG, JPG, audio, or SVG files in `_Assets` does not make them available to ScratchJr.

### 3. Install the MCP server dependencies

Install Node.js 22 or newer with npm, then open PowerShell and verify both commands:

```powershell
node --version
npm.cmd --version
```

Open this project's folder and install the locked dependencies. Replace the path if you copied the project elsewhere. The brackets in this folder name require `-LiteralPath`:

```powershell
Set-Location -LiteralPath 'C:\Users\SkieHackerYT\Desktop\[MCP SERVER]'
npm.cmd ci
```

### 4. Register the server with Claude and Codex

From the same project folder, run:

```powershell
npm.cmd run setup
```

Setup merges the `scratchjr` entry into Claude Desktop's configuration and registers a user-level server with Claude Code and Codex when their CLIs are available. Existing configuration files are backed up next to their originals. Generated configuration snippets are in `config/`.

| Client | Configuration or verification |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`; fully quit and reopen Claude Desktop |
| Claude Code | User-level registration; verify with `claude.cmd mcp get scratchjr`, then start a new session |
| Codex | `%USERPROFILE%\.codex\config.toml`; verify with `codex mcp get scratchjr --json`, then start a new session |

If a CLI is unavailable, setup prints a warning for that client. Install the missing CLI and rerun setup, or merge the corresponding snippet from `config/` into the client's configuration. Codex's generated configuration uses a 120-second tool timeout for longer editor operations. Keep the server folder at its configured location so the clients can find it.

### 5. Add the server to Cursor

Complete steps 1–3 first. `npm.cmd run setup` configures Claude and Codex; **Cursor and Antigravity require the manual configuration below**.

1. Open your project in Cursor.
2. Create or open one of these configuration files. Choose the global file to use ScratchJr across all projects, or the project file for this workspace only.

| Scope | Configuration file on this PC |
| --- | --- |
| Global | `C:\Users\SkieHackerYT\.cursor\mcp.json` |
| Project | `C:\Users\SkieHackerYT\Desktop\[MCP SERVER]\.cursor\mcp.json` |

3. Add the configuration below. If the file already contains servers, merge only the `scratchjr` entry into its existing `mcpServers` object.

```json
{
  "mcpServers": {
    "scratchjr": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\SkieHackerYT\\Desktop\\[MCP SERVER]\\src\\server.js"
      ]
    }
  }
}
```

4. Save the file and restart Cursor. Open **Customize > MCPs** and enable `scratchjr` if needed.
5. Start an Agent chat and ask it to call `scratchjr_connect`, then `scratchjr_list_projects`.

Cursor supports both configuration locations; a project entry takes precedence over a global entry with the same name. See the [official Cursor MCP instructions](https://cursor.com/help/customization/mcp).

The JSON uses this PC's paths. On another machine, adjust the Node executable and server path. Keep the doubled backslashes required by JSON. You can also copy this server entry from [config/claude-desktop.json](config/claude-desktop.json).

### 6. Add the server to Google Antigravity

1. Open Antigravity IDE and its Agent side panel.
2. Click **… > MCP Servers > Manage MCP Servers > View raw config**.
3. In the opened `mcp_config.json`, merge the same `scratchjr` configuration shown above into `mcpServers`. Preserve any other server entries.
4. Save the file, then refresh the MCP server list or restart Antigravity. Ensure `scratchjr` is enabled.
5. Start a new Agent conversation and ask it to call `scratchjr_connect`, then `scratchjr_list_projects`.

Current Antigravity documentation lists these configuration locations:

| Scope | Configuration file on this PC |
| --- | --- |
| Global | `C:\Users\SkieHackerYT\.gemini\config\mcp_config.json` |
| Workspace | `C:\Users\SkieHackerYT\Desktop\[MCP SERVER]\.agents\mcp_config.json` |

Prefer the file opened by **View raw config** for your installed IDE version. Antigravity 2.0 exposes server management under **Settings > Customizations > Installed MCP Servers**. See the [official Antigravity MCP instructions](https://antigravity.google/docs/mcp).

Both editors launch `src/server.js` directly using Node and stdio. No MCP URL or separate `npm start` terminal is needed. Port `9223` is the app's internal debugging connection, not an HTTP MCP endpoint.

### 7. Verify the ScratchJr connection

Save and close any ScratchJr window opened through its ordinary shortcut, then run:

```powershell
npm.cmd run doctor -- --launch
```

This launches ScratchJr with the local connection enabled and reports the detected app settings and projects. To check an already connected app without launching it, use `npm.cmd run doctor`.

In Cursor or Antigravity, try:

> Use the scratchjr tools to create a dancing dog in a park. Build the project, run it, inspect a screenshot, then stop, reset, and save it.

If the tools do not appear, check that `scratchjr` is enabled, the JSON is valid, and both absolute paths exist. Confirm `npm.cmd ci` completed in the server folder, then restart the editor and start a new Agent chat. In Cursor, connection details are available in **Output > MCP Logs**; in Antigravity, inspect the server entry in **Manage MCP Servers**. Follow the editor's tool-approval prompts when shown.

## Procedure:

1. Open Claude Desktop, Claude Code, Codex, Cursor, or Antigravity and start a new Agent conversation after registration.
2. Ask the assistant to call `scratchjr_connect` and check `scratchjr_status`.
3. Describe the story, animation, or game you want. Include characters, scenes, dialogue, and what should happen when a character is clicked.
4. Have the assistant inspect available assets and blocks, create the project, run it, and check a screenshot. For custom artwork, register the SVG from `_Assets` before using it in the project.
5. Test the project in ScratchJr using the green flag and character clicks.
6. Ask for any changes, then stop/reset and save the project. It remains available in ScratchJr's project library.

Example request:

> Use ScratchJr to create an interactive ocean adventure with three characters and two scenes. Make the characters talk and move when clicked. Build it, run it, check a screenshot, and save it.

Example custom-artwork request, after providing the SVG contents or granting the client access to the file:

> Register my star SVG from C:\Users\SkieHackerYT\Documents\ScratchJr\_Assets as a character. Create a space scene where clicking the star makes it spin. Test and save it.

On this PC, **MCP Demo - Park Friends (Ready)** is already in the ScratchJr library. Press the green flag to animate Tic and the dog. Click the dog to visit the stars; click the star to return. To edit it, try:

> Open MCP Demo - Park Friends (Ready). Make the dog hop three times when I click it, then switch to the space scene. Test and save the changes.

### Connection behavior

The configured MCP client starts `src/server.js` using MCP's standard stdio transport. No API keys or model subscriptions are embedded in the server; the connected assistant interprets your request and calls the tools.

The first application tool connects to ScratchJr on **127.0.0.1:9223**, or automatically launches the installed app with that local debugging port. It does not modify the installed application.

If ScratchJr is already running from its ordinary shortcut without the connection enabled, save your work and close it once. Then ask the assistant to connect again. The server does not force-close an existing editor session. You can normally leave the connected app open while using either client. Avoid simultaneous manual edits while an assistant is changing a project.

### Tool reference

| Tool | Action |
| --- | --- |
| `scratchjr_connect` / `scratchjr_status` | Connect, launch, or inspect connection status |
| `scratchjr_list_assets` | Discover installed characters, backgrounds, and sounds |
| `scratchjr_block_reference` | Read block names, allowed arguments, and units |
| `scratchjr_list_projects` / `scratchjr_get_project` | Find projects and inspect their actual data |
| `scratchjr_create_project` | Build a complete project with pages, characters, text, and scripts |
| `scratchjr_edit_project` | Batch edits while preserving unrelated objects |
| `scratchjr_open_project` / `scratchjr_save_project` | Open and persist projects |
| `scratchjr_run_project` / `scratchjr_stop_project` | Start green-flag scripts, stop, or reset |
| `scratchjr_click_character` | Exercise click interactions |
| `scratchjr_add_svg_asset` | Create a custom character or background from static SVG geometry |
| `scratchjr_screenshot` | Return an actual editor screenshot to the assistant |
| `scratchjr_backup` / `scratchjr_export_project` | Back up the database or export project JSON and media |

Also includes the `scratchjr://guide` resource and `create-scratchjr-project` prompt.

ScratchJr supports up to four pages, motion, speech, sounds, repeat loops, click/collision events, colored messages, and page transitions. It does not support Scratch 3 features such as variables, keyboard controls, scores, or arithmetic. The assistant should implement your idea using those available blocks and explain any remaining limitations.

### Development checks

```powershell
npm.cmd test                 # Six automated model/protocol tests; does not launch the app
npm.cmd run doctor          # Inspect connection and list projects
npm.cmd run doctor -- --launch
npm.cmd run test:live        # Creates a new demo in the real ScratchJr library
npm.cmd run test:extended    # Adds a custom star and second page to the latest test demo
```

`npm start` runs the MCP protocol server and waits for client input; it is not a web page. Clients use the absolute Node executable and server path, so their current directory does not matter.

### Optional environment settings

| Variable | Default |
| --- | --- |
| `SCRATCHJR_EXE` | Auto-detected versioned ScratchJr executable |
| `SCRATCHJR_DEBUG_PORT` | `9223` |
| `SCRATCHJR_DATABASE` | `~/Documents/ScratchJR/scratchjr.sqllite` |
| `SCRATCHJR_BACKUP_DIR` | This server's `backups/` folder |
| `SCRATCHJR_OUTPUT_DIR` | This server's `artifacts/` folder |

If you customize settings, use the same values in every client. In the Cursor and Antigravity JSON, place environment settings in an `env` object alongside `command` and `args` within the `scratchjr` entry. If Windows Documents is redirected, set `SCRATCHJR_DATABASE` to the app's actual database path.

### Project input

`examples/park-friends.json` is a complete `scratchjr_create_project` argument. Character `asset` and page `background` values must be exact filenames returned by `scratchjr_list_assets`.

Coordinates use a 480×360 stage with the origin at the top left. One motion step is 24 pixels. `wait: 10` means one second. `right` and `left` rotate; `forward` and `back` move horizontally. Each script is an array of `{op, value?, body?}` objects; a `repeat` block holds its enclosed blocks in `body`.

To change existing work, call `get_project`, then `edit_project` with its `revision`, page/object IDs, and a batch of operations. `set_scripts` changes only code. `set_character` replaces that entire character's configuration. The server rejects a stale revision so two assistants do not silently overwrite one another's changes.

### Persistence and recovery

Project writes use the running application's in-memory database, then explicitly flush to disk. Creating, editing, and adding artwork make timestamped full database backups first. Cross-process locking serializes tool operations between Claude and Codex. There is no arbitrary JavaScript or SQL execution tool.

`backups/` contains complete `.sqllite` snapshots. To restore manually, save and close ScratchJr, preserve a copy of the current database, replace `Documents\ScratchJR\scratchjr.sqllite` with the selected snapshot, and reopen ScratchJr. Restoring a full database restores all projects to that snapshot's state.

`artifacts/` contains screenshots, JSON exports, and `live-test-result.json`. The JSON export includes referenced custom media and is intended for inspection/backup; it is **not** a tablet-importable `.sjr` archive. Automated import and recorded-audio creation are not implemented. Existing recorded sounds can be used in scripts.

Tested against **ScratchJr Desktop 1.3.2 on Windows**, Node 24, MCP SDK 1.30.0, the installed Codex CLI, and Claude Code. Claude Desktop's configuration is installed, but its UI was not used for testing. Cursor and Antigravity instructions follow their official MCP documentation; connections from those editors have not been tested here. Other desktop builds may need an adapter.

Verification completed on this PC: stdio handshake and tool/resource/prompt discovery; native project creation; visible rendering; measured movement after green-flag execution; edits and stale-revision rejection; custom SVG rendering; click-driven navigation between two pages; screenshots; disk persistence; and SQLite integrity. Original Project 1 was compared with the pre-test backup and was unchanged.

Implementation references: [ScratchJr Desktop source](https://github.com/jfo8000/ScratchJr-Desktop/), [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/), and [Claude Desktop MCP configuration](https://github.com/modelcontextprotocol/docs/blob/main/quickstart/user.mdx). Codex and Claude Code registration use their installed CLI commands. This is an independent integration, not an official ScratchJr release.

**Created by: Kerneil Rommel S. Gocotano**
