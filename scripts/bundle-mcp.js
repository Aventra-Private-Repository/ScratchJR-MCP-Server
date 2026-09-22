// Copies the MCP server into desktop/mcp so a packaged app carries its own copy.
//
// The assistant panel runs the server as a child process. When the app is run
// from source it can reach ../src/server.js, but an installed copy has no
// repository around it, so the server and its production dependencies are
// staged here before electron-forge packages the app.
//
// desktop/mcp is generated, never edited, and is gitignored.
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, desktopRoot } from '../src/config.js';

const target = join(desktopRoot, 'mcp');

await rm(target, {recursive: true, force: true});
await mkdir(target, {recursive: true});

await cp(join(root, 'src'), join(target, 'src'), {recursive: true});

// A trimmed manifest: the server's runtime needs only these, and npm should not
// try to install the test or build tooling into the packaged app.
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(target, 'package.json'), JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  private: true,
  type: 'module',
  description: manifest.description,
  engines: manifest.engines,
  dependencies: manifest.dependencies
}, null, 2) + '\n');
await cp(join(root, 'package-lock.json'), join(target, 'package-lock.json'));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: target, stdio: 'inherit', shell: process.platform === 'win32'
});
if (install.status !== 0) throw new Error(`Staging the MCP server dependencies failed with exit code ${install.status}.`);

if (!existsSync(join(target, 'node_modules', '@modelcontextprotocol'))) {
  throw new Error('The MCP SDK is missing from the staged server; the packaged assistant would not start.');
}

console.log(`Staged the MCP server at ${target}`);
