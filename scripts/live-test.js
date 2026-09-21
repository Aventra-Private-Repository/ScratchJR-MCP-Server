import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { root, config } from '../src/config.js';
const client=new Client({name:'scratchjr-live-verification',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'src','server.js')],stderr:'pipe'});
transport.stderr?.on('data',data=>process.stderr.write(data));
async function call(name,args={}) {
  const response=await client.callTool({name:`scratchjr_${name}`,arguments:args},undefined,{timeout:120000});
  if(response.isError) throw new Error(response.content[0].text);
  return name==='screenshot'?response:JSON.parse(response.content[0].text);
}
try {
  await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,17);
  console.log('MCP initialized: 17 tools');
  assert.equal((await call('connect')).connected,true);
  const assets=await call('list_assets');
  assert(assets.characters.some(a=>a.md5==='Dog.svg'));
  console.log(`Catalog: ${assets.characters.length} characters, ${assets.backgrounds.length} backgrounds`);
  const before=await call('list_projects');
  const project=await call('create_project',{project:{name:'MCP Demo - Park Friends',pages:[{
    background:'Park.svg',texts:[{text:'Park Friends',x:240,y:40,color:'#287f46',size:36}],characters:[
      {name:'Tic',asset:'Blue.svg',x:100,y:245,scale:0.5,scripts:[[
        {op:'onflag'},{op:'say',value:'Hello from Claude and Codex!'},{op:'repeat',value:3,body:[{op:'forward',value:1},{op:'hop',value:1}]},{op:'message',value:'Orange'},{op:'endstack'}
      ],[{op:'onclick'},{op:'say',value:'You clicked me!'},{op:'endstack'}]]},
      {name:'Dog',asset:'Dog.svg',x:340,y:270,scale:0.45,scripts:[[{op:'onmessage',value:'Orange'},{op:'hop',value:2},{op:'say',value:'Woof! We made this together.'},{op:'playsnd'},{op:'endstack'}]]}
    ]
  }]}});
  console.log(`Created and opened demo ${project.projectId}`);
  assert.equal((await call('list_projects')).length,before.length+1);
  assert.equal(project.data.pages.length,1);
  const tic=project.data['page 1'].sprites.find(s=>project.data['page 1'][s].name==='Tic');
  await call('run_project',{projectId:project.projectId});
  await new Promise(r=>setTimeout(r,4500));
  const running=await call('get_project',{projectId:project.projectId});
  assert(running.data['page 1'][tic].xcoor>100,'Green flag script should move Tic');
  console.log('Verified real animation changed character position');
  const shot=await call('screenshot');
  assert.equal(shot.content[0].type,'image');
  console.log('Screenshot: '+shot.content[1].text);
  await call('stop_project',{reset:true});
  await call('click_character',{objectId:tic});
  await call('stop_project',{reset:true});
  const current=await call('get_project',{projectId:project.projectId});
  const edited=await call('edit_project',{projectId:project.projectId,expectedRevision:current.revision,operations:[{action:'rename',name:'MCP Demo - Park Friends (Ready)'}]});
  assert(edited.name.endsWith('(Ready)'));
  const conflict=await client.callTool({name:'scratchjr_edit_project',arguments:{projectId:project.projectId,expectedRevision:current.revision,operations:[{action:'rename',name:'Should not happen'}]}});
  assert.equal(conflict.isError,true);
  console.log('Verified edits and stale-revision protection');
  await call('save_project');
  const exported=await call('export_project',{projectId:project.projectId});
  const finalShot=await call('screenshot');
  await mkdir(config.artifactDir,{recursive:true});
  await writeFile(join(config.artifactDir,'live-test-result.json'),JSON.stringify({projectId:project.projectId,screenshot:finalShot.content[1].text,export:exported.path,tools:tools.tools.map(t=>t.name),passed:true},null,2));
  console.log('PASS: live MCP creation, native rendering, execution, click, edit, save, export and screenshot');
} finally {await client.close();}
