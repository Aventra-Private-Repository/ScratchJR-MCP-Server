import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function findExecutable() {
  if (process.env.SCRATCHJR_EXE) return resolve(process.env.SCRATCHJR_EXE);
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ScratchJr');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).filter(n => /^app-/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  return versions.map(v=>join(base,v,'ScratchJr.exe')).find(existsSync) || null;
}
export const config = {
  port: Number(process.env.SCRATCHJR_DEBUG_PORT || 9223),
  executable: findExecutable(),
  database: resolve(process.env.SCRATCHJR_DATABASE || join(homedir(), 'Documents', 'ScratchJR', 'scratchjr.sqllite')),
  backupDir: resolve(process.env.SCRATCHJR_BACKUP_DIR || join(root, 'backups')),
  artifactDir: resolve(process.env.SCRATCHJR_OUTPUT_DIR || join(root, 'artifacts')),
};
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid SCRATCHJR_DEBUG_PORT');
