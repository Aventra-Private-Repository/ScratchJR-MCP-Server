import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const desktopRoot = join(root, 'desktop');

// Squirrel installs to %LOCALAPPDATA%\<installerName>\app-<version>\ScratchJr.exe.
// The build from desktop/ comes first so it wins when a stock copy is also present.
const installDirs = ['ScratchJR-Modified-KerneilGocotano', 'ScratchJr'];

export function findExecutable() {
  if (process.env.SCRATCHJR_EXE) return resolve(process.env.SCRATCHJR_EXE);
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  for (const name of installDirs) {
    const base = join(local, name);
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).filter(n => /^app-/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    const exe = versions.map(v=>join(base,v,'ScratchJr.exe')).find(existsSync);
    if (exe) return exe;
  }
  return null;
}

export const config = {
  port: Number(process.env.SCRATCHJR_DEBUG_PORT || 9223),
  executable: findExecutable(),
  database: resolve(process.env.SCRATCHJR_DATABASE || join(homedir(), 'Documents', 'ScratchJR', 'scratchjr.sqllite')),
  backupDir: resolve(process.env.SCRATCHJR_BACKUP_DIR || join(root, 'backups')),
  artifactDir: resolve(process.env.SCRATCHJR_OUTPUT_DIR || join(root, 'artifacts')),
};
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid SCRATCHJR_DEBUG_PORT');
