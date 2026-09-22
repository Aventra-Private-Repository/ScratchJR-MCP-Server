# Scratch.JR [ AI-Assisted ] v1.0.2

A build of the ScratchJr desktop app with an AI assistant panel underneath the editor. Ask it for a story in plain words and it builds the project in the real editor: characters, backgrounds, pages and block scripts, then runs it and shows you a screenshot.

You bring your own API key. Nothing is sent anywhere until you send a message, and there is no account, subscription or telemetry in this app.

## Install

Download **`Scratch.JR [ AI-Assisted ]-1.0.2 Setup.exe`** and run it. It installs to your user folder, so it does not ask for administrator rights.

Windows will show a **"Windows protected your PC"** warning, because the installer is not code-signed. Click **More info**, then **Run anyway**. If you would rather not, you can build it yourself from source instead.

## Setting up the assistant

1. Open **File > Settings**.
2. Choose **DeepSeek** or **OpenRouter**.
3. Paste your API key. Get one at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) or [openrouter.ai/keys](https://openrouter.ai/keys).
4. Leave **Model name** blank for the provider's default, or type any model it accepts.

Then type something like *"make a story about a dog in the park"* into the chat box.

**Costs money.** Every message is a paid request on your own account, and one story usually takes several, because the assistant calls tools and reads the results. **Settings > Advanced > Tool rounds per message** caps how many times it may do that per message; twelve is the default.

**Your key is stored in plain text** in `ai-settings.json` inside the app's data folder. Treat that file the way you would treat the key.

## Node.js

The assistant needs Node.js 22 or newer to run its tool server. You do not have to install it. The first time you send a message the app checks for a suitable Node and, finding none, downloads a portable copy (about 36 MB) into its own folder.

That copy needs no administrator rights, changes nothing about your `PATH`, and does not interfere with any Node you already have. A Node already installed and new enough is used as it is. Uninstalling the app removes the downloaded copy with it.

## Using it from Claude, Codex, Cursor or Antigravity instead

The same tools are available over MCP to an external editor. This build opens the connection on `127.0.0.1:9223` as it starts, so a window already on screen can be driven without closing and reopening it. See the repository README for how to register the server with each client.

## What ScratchJr can and cannot do

The assistant works inside the app's real limits and will tell you when it hits one:

- Four pages per project. More scenes than that need a second project.
- No variables, scores, keyboard input or arithmetic. Interaction comes from taps, collisions, colour messages and page changes.

## Credits

- [jfo8000](https://github.com/jfo8000/ScratchJr-Desktop) — the open-source desktop port this is built on
- [SkieAdminYT](https://github.com/SkieAdmin) — MCP and AI integration
- [MIT Media Lab](https://www.scratchjr.org) — the original ScratchJr

ScratchJr is a project of the Lifelong Kindergarten Group at the MIT Media Lab, the Developmental Technologies group at Tufts University, and the Playful Invention Company. This is a modified fork of the community desktop port, distributed under the MIT licence. It is not produced or endorsed by MIT.

## Files in this release

| File | What it is |
| --- | --- |
| `Scratch.JR [ AI-Assisted ]-1.0.2 Setup.exe` | The installer. This is the one to download. |
| `ScratchJR-AI-Assisted-1.0.2-full.nupkg` | Squirrel update package. Only needed if you host updates. |
| `RELEASES` | Squirrel update manifest. Same. |
