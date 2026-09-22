import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root } from '../src/config.js';

const serverFile = join(root, 'src', 'server.js');
const entry = {command: process.execPath, args: [serverFile]};

// Windows paths differ only by case and separator, so compare them normalized.
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  resolve(a).toLowerCase() === resolve(b).toLowerCase();
const pointsHere = server => Array.isArray(server?.args) && server.args.some(arg => samePath(arg, serverFile));

const configDir = join(root, 'config');
await mkdir(configDir, {recursive: true});
await writeFile(join(configDir, 'claude-desktop.json'), JSON.stringify({mcpServers: {scratchjr: entry}}, null, 2) + '\n');
await writeFile(join(configDir, 'codex.toml'), `[mcp_servers.scratchjr]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n`);

const desktop = process.platform === 'win32'
  ? join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
  : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
let existing = {};
try { existing = JSON.parse(await readFile(desktop, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const current = existing.mcpServers?.scratchjr;
if (pointsHere(current)) {
  console.log(`Claude Desktop already points at this folder: ${desktop}`);
} else {
  // A scratchjr entry left behind by an older copy of this project would launch
  // whatever now lives at that path, so repoint it rather than refusing.
  try { await copyFile(desktop, `${desktop}.scratchjr-${Date.now()}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current) console.log(`Claude Desktop had scratchjr pointing at ${current.args?.[0] ?? 'an unknown command'}; repointing it here. The previous file was backed up next to it.`);
  existing.mcpServers = {...existing.mcpServers, scratchjr: entry};
  await mkdir(dirname(desktop), {recursive: true});
  await writeFile(desktop, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Claude Desktop configured: ${desktop}`);
}

if (process.platform === 'win32') {
  const setup = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','setup-clients.ps1'),'-ServerFile',serverFile,'-NodePath',entry.command], {stdio:'inherit', windowsHide:true});
  if (setup.status !== 0) process.exitCode = setup.status || 1;
} else {
  for (const [command, args] of [['codex',['mcp','add','scratchjr','--',entry.command,serverFile]],['claude',['mcp','add','--scope','user','scratchjr','--',entry.command,serverFile]]]) {
    const result = spawnSync(command, args, {stdio:'inherit'});
    if (result.error || result.status !== 0) process.exitCode = 1;
  }
}

// The Codex CLI may not be installed even though Codex itself is, in which case
// nothing above could have touched its config. Say so instead of leaving a
// stale entry to fail silently at the next session.
const codexConfig = join(homedir(), '.codex', 'config.toml');
try {
  const toml = await readFile(codexConfig, 'utf8');
  const start = toml.indexOf('[mcp_servers.scratchjr]');
  const rest = start < 0 ? '' : toml.slice(start + 1);
  const next = rest.search(/^\[/m);
  const section = start < 0 ? null : (next < 0 ? toml.slice(start) : toml.slice(start, start + 1 + next));
  // TOML escapes each backslash in a basic string and leaves a literal string
  // alone, so compare with every backslash removed from both sides.
  const flat = text => text.toLowerCase().split('\\').join('');
  if (section && !flat(section).includes(flat(serverFile))) {
    console.warn(`\nWarning: ${codexConfig} still has a scratchjr entry that does not point at ${serverFile}.`);
    console.warn(`Replace that [mcp_servers.scratchjr] section with the contents of ${join(configDir,'codex.toml')}.`);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

console.log('Restart Claude and start a new Codex session to load scratchjr.');
