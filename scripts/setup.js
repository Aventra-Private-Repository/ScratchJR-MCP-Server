import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root } from '../src/config.js';
const entry={command:process.execPath,args:[join(root,'src','server.js')]};
const configDir=join(root,'config');
await mkdir(configDir,{recursive:true});
await writeFile(join(configDir,'claude-desktop.json'),JSON.stringify({mcpServers:{scratchjr:entry}},null,2)+'\n');
await writeFile(join(configDir,'codex.toml'),`[mcp_servers.scratchjr]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n`);
const desktop=process.platform==='win32'?join(process.env.APPDATA,'Claude','claude_desktop_config.json'):join(homedir(),'Library','Application Support','Claude','claude_desktop_config.json');
let existing={};
try {existing=JSON.parse(await readFile(desktop,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
if(existing.mcpServers?.scratchjr && JSON.stringify(existing.mcpServers.scratchjr)!==JSON.stringify(entry)) throw new Error('A different Claude Desktop server already uses the name scratchjr. Nothing was overwritten.');
if(!existing.mcpServers?.scratchjr) {
  try{await copyFile(desktop,`${desktop}.scratchjr-${Date.now()}.bak`);}catch(e){if(e.code!=='ENOENT')throw e;}
  existing.mcpServers={...existing.mcpServers,scratchjr:entry};
  await mkdir(dirname(desktop),{recursive:true});
  await writeFile(desktop,JSON.stringify(existing,null,2)+'\n');
}
console.log(`Claude Desktop configured: ${desktop}`);
if(process.platform==='win32') {
  const setup=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','setup-clients.ps1'),'-ServerFile',entry.args[0],'-NodePath',entry.command],{stdio:'inherit',windowsHide:true});
  if(setup.status!==0)process.exitCode=setup.status || 1;
} else {
  for(const [command,args] of [['codex',['mcp','add','scratchjr','--',entry.command,...entry.args]],['claude',['mcp','add','--scope','user','scratchjr','--',entry.command,...entry.args]]]) {
    const result=spawnSync(command,args,{stdio:'inherit'});if(result.error || result.status!==0)process.exitCode=1;
  }
}
console.log('Restart Claude and start a new Codex session to load scratchjr.');
