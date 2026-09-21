import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ScratchJrService, withLock, guide } from './service.js';
import { projectSchema, editSchema } from './model.js';

const service=new ScratchJrService();
const server=new McpServer({name:'scratchjr-desktop',version:'1.0.0'},{instructions:
  'Control the real local ScratchJr Desktop app. For creation requests, inspect assets and blocks, then create the complete project, run it and inspect a screenshot. Do not merely describe steps. Work within ScratchJr capabilities. Use get_project and revision-checked edit_project for existing work. New projects never overwrite existing projects. Connection launches the app if needed. Save and close a preexisting non-debug app before reconnecting. All normal tool calls are serialized across Claude and Codex. Do not claim an action succeeded if a tool returned an error.'});
const id=z.number().int().positive().describe('Project ID from list_projects or create_project');
function result(value){return {content:[{type:'text',text:JSON.stringify(value,null,2)}]};}
function tool(name,description,inputSchema,handler,{readOnly=false,connect=true}={}) {
  server.registerTool(`scratchjr_${name}`,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false}},async args=> {
    try{return await withLock(async()=>{if(connect)await service.bridge.connect();return result(await handler(args));});}
    catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
  });
}
tool('status','Check the live ScratchJr connection without launching the app.',{},()=>service.status(),{readOnly:true,connect:false});
tool('connect','Connect to ScratchJr Desktop or launch it with a localhost-only control port. Does not force-close existing sessions.',{},()=>service.status());
tool('list_assets','List real installed character, background and sound assets. Use exact md5 filenames in projects.',{kind:z.enum(['all','characters','backgrounds','sounds']).default('all'),search:z.string().max(100).optional()},async ({kind,search})=> {
  const assets=await service.assets();
  return Object.fromEntries(Object.entries(assets).filter(([k])=>kind==='all'||kind===k).map(([k,v])=>[k,v.filter(a=>!search||JSON.stringify(a).toLowerCase().includes(search.toLowerCase()))]));
},{readOnly:true});
tool('block_reference','Get supported blocks, values, units and ScratchJr project-building guidance.',{},()=>guide,{readOnly:true,connect:false});
tool('list_projects','List saved ScratchJr projects.',{},()=>service.listProjects(),{readOnly:true});
tool('get_project','Read project data, page/object IDs and revision. Includes unsaved editor state when open. Call before editing.',{projectId:id},({projectId})=>service.getProject(projectId),{readOnly:true});
tool('create_project','Create, persist and open a complete native ScratchJr project with up to four pages. Characters, backgrounds, text and block scripts are built automatically. Returns the new ID and data.',{project:projectSchema},({project})=>service.create(project));
tool('edit_project','Apply a batch of edits to an existing project and reopen it. Supply the revision from get_project. set_character replaces the whole character; use set_scripts to change only code.',{projectId:id,expectedRevision:z.string().length(24),operations:z.array(editSchema).min(1).max(100)},({projectId,expectedRevision,operations})=>service.edit(projectId,expectedRevision,operations));
tool('open_project','Save the current project and open the requested project in the real editor.',{projectId:id},({projectId})=>service.open(projectId));
tool('save_project','Save the open project, regenerate its thumbnail and flush all data to disk.',{},()=>service.bridge.save());
tool('run_project','Run green-flag scripts in the current project, optionally opening a specified project.',{projectId:id.optional()},({projectId})=>service.run(projectId));
tool('stop_project','Stop scripts; optionally reset characters to their starting positions.',{reset:z.boolean().default(false)},({reset})=>service.stop(reset));
tool('click_character','Trigger a character click event to test an interactive project. Character must be on the current page.',{objectId:z.string().min(1).max(150)},({objectId})=>service.clickCharacter(objectId));
tool('backup','Save current work and make a full timestamped database backup.',{},async()=>({path:await service.backup()}));
tool('export_project','Export a JSON backup of a project and referenced custom media. This is not the tablet .sjr sharing format.',{projectId:id},({projectId})=>service.exportProject(projectId),{readOnly:true});
tool('add_svg_asset','Add a custom character or background using static SVG geometry. Use SVG with a matching viewBox; backgrounds should be 480×360. Returns an md5 asset name usable in projects.',{
  name:z.string().min(1).max(80),kind:z.enum(['character','background']),svg:z.string().min(20).max(250000),width:z.number().int().min(1).max(2048),height:z.number().int().min(1).max(2048)
},args=>service.addSvg(args));
server.registerTool('scratchjr_screenshot',{description:'Capture the real ScratchJr window and return an image for visual verification, plus its saved file path.',inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false}},async()=> {
  try{return await withLock(async()=> {await service.bridge.connect();const shot=await service.screenshot();return {content:[{type:'image',mimeType:'image/png',data:shot.data},{type:'text',text:shot.path}]};});}
  catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
});
server.registerResource('guide','scratchjr://guide',{mimeType:'application/json',description:'ScratchJr workflow and supported block reference'},async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(guide,null,2)}]}));
server.registerPrompt('create-scratchjr-project',{description:'Build and verify a ScratchJr story, animation or game.',argsSchema:{idea:z.string()}},({idea})=>({messages:[{role:'user',content:{type:'text',text:`Create this in ScratchJr Desktop: ${idea}. Inspect the asset and block tools, build the complete project, run it, inspect a screenshot, then stop/reset and save. Use ScratchJr-supported interactions and explain any limitations.`}}]}));
const transport=new StdioServerTransport();
await server.connect(transport);
transport.onclose=()=>{service.close();process.exit(0);};
process.on('SIGINT',()=>{service.close();process.exit(0);});
process.on('SIGTERM',()=>{service.close();process.exit(0);});
