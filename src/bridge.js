import WebSocket from 'ws';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, basename } from 'node:path';
import { config } from './config.js';

const exec = promisify(execFile);
export const delay = ms => new Promise(r=>setTimeout(r,ms));
// ScratchJr Desktop 1.3.2 uses Electron 2. Keep injected code compatible with Chrome 61.
const prelude = `
function mod(suffix) {
  var key = Object.keys(require.cache).filter(function(k) { return k.replace(/\\\\/g, '/').endsWith(suffix); })[0];
  if (!key) throw new Error('Unsupported ScratchJr build: module missing ' + suffix);
  return require(key).default;
}
var SJ = mod('/editor/ScratchJr.js');
var Project = mod('/editor/ui/Project.js');
var IO = mod('/iPad/IO.js');
function query(stmt, values) { return JSON.parse(window.tablet.database_query(JSON.stringify({stmt:stmt, values:values || []}))); }
function statement(stmt, values) { var result = window.tablet.database_stmt(JSON.stringify({stmt:stmt, values:values || []})); if (Number(result) < 0) throw new Error('ScratchJr database rejected the operation'); return result; }
function flush() {
  // The stock app flushes its in-memory SQL database when removing a media file.
  // A random nonexistent filename flushes without changing existing assets.
  window.tablet.io_remove('__mcp_flush_' + require('crypto').randomBytes(16).toString('hex') + '.tmp');
}
`;

export class Bridge {
  constructor() { this.ws = null; this.nextId = 0; this.pending = new Map(); }
  async targets() {
    const response = await fetch(`http://127.0.0.1:${config.port}/json`, {signal:AbortSignal.timeout(1500)});
    if (!response.ok) throw new Error('Debug endpoint unavailable');
    return response.json();
  }
  async connect(launch = true) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    let targets;
    try { targets = await this.targets(); }
    catch (error) {
      if (!launch) throw new Error('ScratchJr is not connected. Call scratchjr_connect.');
      if (!config.executable) throw new Error('ScratchJr executable not found. Set SCRATCHJR_EXE.');
      if (process.platform === 'win32') {
        const image = basename(config.executable);
        const {stdout} = await exec('tasklist.exe', ['/FI',`IMAGENAME eq ${image}`,'/FO','CSV','/NH'], {windowsHide:true});
        if (stdout.toLowerCase().includes(`"${image.toLowerCase()}"`)) throw new Error('ScratchJr is running without the MCP connection. Save and close ScratchJr, then call scratchjr_connect. It will reopen automatically; no process is forcibly closed.');
      }
      const env = {...process.env};
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const child = spawn(config.executable,[`--remote-debugging-port=${config.port}`,'--remote-debugging-address=127.0.0.1'],{
        cwd:dirname(config.executable), env, detached:true, windowsHide:true, stdio:'ignore'
      });
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
      child.unref();
      for (let i=0;i<60;i++) {
        try { targets = await this.targets(); if (targets.some(t=>t.type==='page' && /\/app\/(index|home|editor)\.html/.test(t.url))) break; } catch {}
        await delay(250);
      }
    }
    const target = targets?.find(t=>t.type==='page' && /^file:/.test(t.url) && /\/app\/(index|home|editor)\.html/.test(t.url));
    if (!target) throw new Error(`Port ${config.port} is not a supported ScratchJr Desktop window.`);
    // A page reports no debugger URL while DevTools is attached to it.
    if (!target.webSocketDebuggerUrl) throw new Error('ScratchJr has DevTools open on its window. Close DevTools, then call scratchjr_connect.');
    const socketUrl = new URL(target.webSocketDebuggerUrl);
    if (!['127.0.0.1','localhost','[::1]'].includes(socketUrl.hostname)) throw new Error('Refusing non-local debug connection');
    const ws = new WebSocket(socketUrl);
    await new Promise((resolve,reject)=> {
      const timeout=setTimeout(()=>{ws.terminate();reject(new Error('Debug connection timed out'))},5000);
      ws.once('open',()=>{clearTimeout(timeout);resolve()});
      ws.once('error',e=>{clearTimeout(timeout);reject(e)});
    });
    this.ws=ws;
    ws.on('message',raw=> {
      const message=JSON.parse(raw.toString());
      const p=this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    });
    const disconnected = () => {
      if(this.ws===ws) this.ws=null;
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('ScratchJr disconnected'))}
      this.pending.clear();
    };
    ws.on('close',disconnected); ws.on('error',disconnected);
    await this.waitFor(`typeof window.tablet === 'object' && typeof require === 'function'`, false);
    await this.evaluate(`require('electron').remote.getCurrentWindow().show();return true;`,{},false);
    // A fresh launch sits on the splash screen, which waits for a child to tap
    // Start and has none of the editor modules loaded. Step past it so the
    // first tool call is not met with 'module missing /editor/ScratchJr.js'.
    if (/\/index\.html$/.test(await this.evaluate(`return location.pathname;`,{},false))) {
      await this.send('Page.navigate',{url:await this.evaluate(`return new URL('home.html', location.href).href;`,{},false)});
      await this.waitFor('true');
    }
  }
  async send(method,params={}) {
    if(this.ws?.readyState!==WebSocket.OPEN) throw new Error('ScratchJr disconnected. Call scratchjr_connect.');
    const id=++this.nextId;
    return new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out. Check ScratchJr before retrying a write.`))},30000);
      this.pending.set(id,{resolve,reject,timer});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  async evaluate(body, args={}, modules=true) {
    const expression=`Promise.resolve().then(function(){${modules?prelude:''}\nvar args=${JSON.stringify(args)};\n${body}\n})`;
    const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.result?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async waitFor(condition,modules=true) {
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      try { if(await this.evaluate(`return Boolean(${condition});`,{},modules)) return; } catch(error) {
        if (!this.ws) throw error;
      }
      await delay(150);
    }
    throw new Error('ScratchJr did not finish loading within 20 seconds.');
  }
  async save() {
    return this.evaluate(`
      if (!SJ.stage || !SJ.stage.currentPage) { flush(); return {saved:false,reason:'No open project'}; }
      if (SJ.editmode !== 'edit') throw new Error('Open a normal project before saving.');
      SJ.stopStrips();
      return new Promise(function(resolve,reject){
        if(Project.error) return reject(new Error('ScratchJr reported a project load error'));
        Project.prepareToSave(SJ.currentProject,function(){flush();resolve({saved:true,projectId:Number(SJ.currentProject)});});
      });
    `);
  }
  async open(id, saveCurrent=true) {
    if(saveCurrent) await this.save();
    const url=await this.evaluate(`return new URL('editor.html?mode=edit&pmd5='+args.id,location.href).href;`,{id});
    await this.send('Page.navigate',{url});
    await this.waitFor(`SJ.currentProject == ${Number(id)} && SJ.stage && SJ.stage.currentPage && Project.mediaCount === 0 && !Project.error && document.getElementById('backdrop') && document.getElementById('backdrop').className.indexOf('in') < 0`);
    return {projectId:Number(id),opened:true};
  }
  close() { this.ws?.close(); }
}
