// One-click installer for the modified ScratchJR desktop app plus this MCP server.
//
//   npm run one-click          (or double-click install.cmd)
//
// Steps: install dependencies, fetch the Electron runtime, build a Squirrel
// installer, run it, then register the MCP server with the local Claude and
// Codex clients. Each step prints what it is doing and stops on the first
// failure with a message that says what to fix.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root, desktopRoot, findExecutable } from '../src/config.js';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronDir = join(desktopRoot, 'node_modules', 'electron-prebuilt-compile', 'node_modules', 'electron');
const electronBinary = join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

let step = 0;
const say = message => console.log(`\n[${++step}] ${message}`);

// Electron 1.8 refuses to start when it inherits these from a parent Electron
// process, such as an editor's integrated terminal.
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

function run(command, args, cwd, hint) {
  const result = spawnSync(command, args, {cwd, env, stdio: 'inherit', shell: process.platform === 'win32'});
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}${hint ? `\n${hint}` : ''}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${hint ? `\n${hint}` : ''}`);
}

function newestInstaller() {
  const base = join(desktopRoot, 'out', 'make');
  if (!existsSync(base)) return null;
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.exe$/i.test(entry.name)) found.push(full);
    }
  };
  walk(base);
  return found.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0] || null;
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) throw new Error(`Node 22 or newer is required; this is Node ${process.versions.node}.`);

say('Installing MCP server dependencies');
run(npm, ['install', '--no-audit', '--no-fund'], root);

say('Installing desktop app dependencies (this one is slow, roughly 900 packages)');
run(npm, ['install', '--no-audit', '--no-fund'], desktopRoot);

// npm 11 defers install scripts, so the Electron runtime download can be skipped.
if (existsSync(electronBinary)) {
  say('Electron runtime already downloaded');
} else {
  say('Downloading the Electron runtime');
  run(process.execPath, ['install.js'], electronDir,
    'If this fails behind a proxy, set ELECTRON_MIRROR or download Electron 1.8.2-beta.3 by hand into desktop/node_modules/electron-prebuilt-compile/node_modules/electron/dist.');
}

say('Building the installer');
run(npm, ['run', 'make64'], desktopRoot);

const installer = newestInstaller();
if (!installer) throw new Error('The build finished but no installer was produced under desktop/out/make.');

say(`Running the installer: ${installer}`);
console.log('Squirrel installs to %LOCALAPPDATA% and starts the app when it finishes.');
run(installer, [], desktopRoot);

say('Registering the MCP server with Claude and Codex');
run(process.execPath, [join(root, 'scripts', 'setup.js')], root);

console.log(`\nDone. The MCP server will drive: ${findExecutable() || 'no executable found — set SCRATCHJR_EXE'}`);
console.log('Restart Claude Desktop and start a new Codex session to load the scratchjr tools.');
