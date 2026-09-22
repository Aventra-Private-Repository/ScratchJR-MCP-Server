import { mkdir, writeFile, readFile, copyFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { Bridge, delay } from './bridge.js';
import { compileProject, applyEdits, BLOCKS } from './model.js';

export const revision = record => createHash('sha256').update(JSON.stringify({name:record.name,data:record.data})).digest('hex').slice(0,24);

// Both Claude and Codex may start a server. Serialize app navigation and writes across processes.
export async function withLock(callback) {
  await mkdir(config.backupDir,{recursive:true});
  const lock=join(config.backupDir,'scratchjr.lock');
  const deadline=Date.now()+60000;
  while(true) {
    try {await writeFile(lock,JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});break;}
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      try {
        const info=JSON.parse(await readFile(lock,'utf8'));
        try {process.kill(info.pid,0);} catch(e) {if(e.code==='ESRCH') {await unlink(lock);continue;}}
      } catch(e) {
        if(e.code==='ENOENT') continue;
        if(e instanceof SyntaxError && Date.now()-(await stat(lock)).mtimeMs>10000) {await unlink(lock);continue;}
      }
      if(Date.now()>deadline) throw new Error('Another ScratchJr operation is still running. Retry shortly.');
      await delay(150);
    }
  }
  try{return await callback();} finally {await unlink(lock).catch(()=>{});}
}

export class ScratchJrService {
  constructor(){this.bridge=new Bridge();}
  async status() {
    try {
      await this.bridge.connect(false);
      return await this.bridge.evaluate(`return {connected:true,url:location.href,version:window.Settings.scratchJrVersion,build:window.Settings.buildName || 'ScratchJr Desktop (upstream)',buildVersion:window.Settings.buildVersion || null,projectId:SJ.currentProject ? Number(SJ.currentProject) : null,pageId:SJ.stage && SJ.stage.currentPage ? SJ.stage.currentPage.id : null};`);
    } catch(error) {return {connected:false,reason:error.message,executable:config.executable,port:config.port};}
  }
  async assets() {
    return this.bridge.evaluate(`
      var media=JSON.parse(window.tablet.io_gettextresource('media.json'));
      function normalize(rows){return rows.map(function(row){var r={};Object.keys(row).forEach(function(k){r[k.toLowerCase()]=row[k];});return r;});}
      return {characters:media.sprites.concat(normalize(query('SELECT MD5,NAME,WIDTH,HEIGHT FROM USERSHAPES'))),
        backgrounds:media.backgrounds.concat(normalize(query('SELECT MD5,WIDTH,HEIGHT FROM USERBKGS'))),
        sounds:[{md5:'pop.mp3',name:'Pop'}].concat(normalize(query("SELECT MD5 FROM PROJECTFILES WHERE MD5 LIKE '%.wav' OR MD5 LIKE '%.webm' OR MD5 LIKE '%.mp3'")))};
    `);
  }
  async listProjects() {
    return this.bridge.evaluate(`return query('SELECT ID,NAME,MTIME,THUMBNAIL FROM PROJECTS WHERE DELETED = ? AND GALLERY IS NULL ORDER BY ID DESC',['NO']).map(function(p){return {projectId:p.ID,name:p.NAME,modified:p.MTIME};});`);
  }
  async getProject(id) {
    const record=await this.bridge.evaluate(`
      var rows=query('SELECT ID,NAME,JSON,THUMBNAIL FROM PROJECTS WHERE ID = ? AND DELETED = ?',[args.id,'NO']);
      if(!rows.length) throw new Error('Project not found: '+args.id);
      var p=rows[0];
      var live=SJ.currentProject == args.id && SJ.stage && SJ.stage.currentPage && !Project.error;
      return {projectId:Number(p.ID),name:live?Project.metadata.name:p.NAME,data:live?Project.getProject(SJ.stage.currentPage.id):JSON.parse(p.JSON),thumbnail:p.THUMBNAIL,live:Boolean(live)};
    `,{id});
    record.revision=revision(record);
    return record;
  }
  async backup() {
    await this.bridge.save();
    const path=join(config.backupDir,`scratchjr-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.sqllite`);
    await mkdir(config.backupDir,{recursive:true});
    await copyFile(config.database,path);
    return path;
  }
  async create(input) {
    const project=compileProject(input,await this.assets());
    const backup=await this.backup();
    const id=await this.bridge.evaluate(`
      var id=statement('INSERT INTO PROJECTS (NAME,VERSION,DELETED,MTIME,ISGIFT,JSON,THUMBNAIL) VALUES (?,?,?,?,?,?,?)',
        [args.name,window.Settings.scratchJrVersion,'NO',String(Date.now()),0,JSON.stringify(args.data),null]);
      flush();return Number(id);
    `,project);
    try {
      await this.bridge.open(id,false);
      await this.bridge.save();
      return {...await this.getProject(id),backup,opened:true};
    } catch(error) {throw new Error(`Project ${id} was inserted but could not finish opening: ${error.message}. Backup: ${backup}. Inspect before retrying creation.`);}
  }
  async edit(id,expectedRevision,operations) {
    const current=await this.getProject(id);
    if(current.revision!==expectedRevision) throw new Error('Project changed since it was read. Call scratchjr_get_project and use its new revision before editing.');
    const updated=applyEdits(current,operations,await this.assets());
    const backup=await this.backup();
    await this.bridge.evaluate(`statement('UPDATE PROJECTS SET NAME=?,JSON=?,MTIME=? WHERE ID=?',[args.name,JSON.stringify(args.data),String(Date.now()),args.projectId]);flush();`,updated);
    try {
      await this.bridge.open(id,false);
      await this.bridge.save();
      return {...await this.getProject(id),backup};
    } catch(error) {
      await this.bridge.evaluate(`statement('UPDATE PROJECTS SET NAME=?,JSON=?,THUMBNAIL=? WHERE ID=?',[args.name,JSON.stringify(args.data),args.thumbnail,args.projectId]);flush();`,current);
      await this.bridge.open(id,false).catch(()=>{});
      throw new Error(`Edit could not load; prior project data restored. ${error.message}. Backup: ${backup}`);
    }
  }
  async open(id) {await this.getProject(id);return this.bridge.open(id);}
  async run(id) {
    if(id!==undefined) {
      const state=await this.status();
      if(state.projectId!==id) await this.open(id);
    }
    return this.bridge.evaluate(`
      if(!SJ.stage || !SJ.stage.currentPage) throw new Error('Open a project first');
      SJ.stopStrips();SJ.startGreenFlagThreads();
      return {running:true,projectId:Number(SJ.currentProject),pageId:SJ.stage.currentPage.id};
    `);
  }
  async stop(reset=false) {
    return this.bridge.evaluate(`if(!SJ.stage || !SJ.stage.currentPage) throw new Error('Open a project first');SJ.stopStrips();if(args.reset)SJ.resetSprites();return {stopped:true,reset:args.reset};`,{reset});
  }
  async clickCharacter(id) {
    return this.bridge.evaluate(`
      if(!SJ.stage || !SJ.stage.currentPage) throw new Error('Open a project first');
      var node=document.getElementById(args.id);
      if(!node || !node.owner || node.owner.type !== 'sprite' || node.parentNode !== SJ.stage.currentPage.div) throw new Error('Character is not on the current page');
      SJ.startScriptsFor(node.owner,['onclick']);return {clicked:args.id};
    `,{id});
  }
  async screenshot() {
    const result=await this.bridge.send('Page.captureScreenshot',{format:'png'});
    await mkdir(config.artifactDir,{recursive:true});
    const path=join(config.artifactDir,`scratchjr-${Date.now()}.png`);
    await writeFile(path,Buffer.from(result.data,'base64'));
    return {path,data:result.data};
  }
  async exportProject(id) {
    const project=await this.getProject(id);
    const files=await this.bridge.evaluate(`
      var references={};
      args.data.pages.forEach(function(p){var page=args.data[p];if(page.md5)references[page.md5]=true;
        page.sprites.forEach(function(s){var sprite=page[s];if(sprite.md5)references[sprite.md5]=true;(sprite.sounds || []).forEach(function(a){references[a]=true;});});});
      return Object.keys(references).map(function(md5){var rows=query('SELECT MD5,CONTENTS FROM PROJECTFILES WHERE MD5=?',[md5]);return rows[0];}).filter(Boolean);
    `,project);
    const path=join(config.artifactDir,`project-${id}-${Date.now()}.scratchjr.json`);
    await mkdir(config.artifactDir,{recursive:true});
    await writeFile(path,JSON.stringify({format:'scratchjr-mcp-backup-v1',project,files},null,2));
    return {path,format:'scratchjr-mcp-backup-v1',note:'JSON backup with referenced custom media; not an .sjr share archive.'};
  }
  async addSvg({name,kind,svg,width,height}) {
    // Parse in the actual renderer, allowing only static SVG geometry and local fragment references.
    await this.bridge.evaluate(`
      var doc=new DOMParser().parseFromString(args.svg,'image/svg+xml');
      if(doc.getElementsByTagName('parsererror').length || doc.documentElement.localName!=='svg') throw new Error('Invalid SVG');
      var allowed=['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','title','desc'];
      var nodes=doc.getElementsByTagName('*');
      for(var i=0;i<nodes.length;i++) {
        if(allowed.indexOf(nodes[i].localName)<0) throw new Error('Unsupported SVG element '+nodes[i].localName);
        for(var j=0;j<nodes[i].attributes.length;j++) {
          var a=nodes[i].attributes[j];
          if(/^on/i.test(a.name) || /href|style/i.test(a.name) || /javascript:|data:|https?:|file:/i.test(a.value) && a.name!=='xmlns' || /url\\(\\s*[^#]/i.test(a.value)) throw new Error('SVG must use static geometry without external references, styles, or event handlers');
        }
      }
    `,{svg});
    const backup=await this.backup();
    const result=await this.bridge.evaluate(`
      var doc=new DOMParser().parseFromString(args.svg,'image/svg+xml');
      doc.documentElement.setAttribute('width',args.width);doc.documentElement.setAttribute('height',args.height);
      var normalized=new XMLSerializer().serializeToString(doc.documentElement);
      var base64=new Buffer(normalized,'utf8').toString('base64');
      var md5=window.tablet.io_setmedia(base64,'svg');
      if(args.kind==='character') statement('INSERT INTO USERSHAPES (MD5,WIDTH,HEIGHT,EXT,NAME,SCALE,VERSION) VALUES (?,?,?,?,?,?,?)',[md5,args.width,args.height,'svg',args.name,0.5,window.Settings.scratchJrVersion]);
      else statement('INSERT INTO USERBKGS (MD5,WIDTH,HEIGHT,EXT,VERSION) VALUES (?,?,?,?,?)',[md5,args.width,args.height,'svg',window.Settings.scratchJrVersion]);
      flush();return {md5:md5,kind:args.kind,name:args.name,width:args.width,height:args.height};
    `,{name,kind,svg,width,height});
    return {...result,backup};
  }
  close(){this.bridge.close();}
}

export const guide={
  workflow:['connect','list_assets and block_reference','create_project with complete pages, characters, and scripts','run_project','screenshot','stop_project with reset=true','save_project'],
  editing:'Get project first. Edit using page IDs, object IDs, and expectedRevision. Edits preserve objects that are not mentioned. Batch edits into one call.',
  coordinates:'Stage is 480×360. x increases right, y increases down. Use x/y for initial character position. Movement uses 24-pixel steps. Text x/y is the centre of the text, not its left edge, so a title reads best at x 240; a small x clips it off the left of the stage.',
  limits:'ScratchJr supports 4 pages and the listed blocks. It has no variables, scores, keyboard controls, or general arithmetic. Use click events, collision events, colored messages, and page transitions for interactive stories and games.',
  scripts:'Each script is an array of {op,value?,body?}. Use onflag/onclick/ontouch/onmessage first for automatic execution. repeat owns body; forever repeats the whole strip and is last.',
  persistence:'Writes go through the running app and flush to disk. Automatic database backups precede changes. Never edit the SQLite file while ScratchJr is running.',
  blocks:BLOCKS
};
