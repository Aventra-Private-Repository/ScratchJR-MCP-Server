import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root } from '../src/config.js';
import { join } from 'node:path';
test('stdio protocol initializes and discovers tools, resources, prompts without ScratchJr',async()=> {
  const client=new Client({name:'test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'src/server.js')],env:{...process.env,SCRATCHJR_DEBUG_PORT:'19223'}});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();assert.equal(tools.length,17);
    assert(tools.some(t=>t.name==='scratchjr_create_project' && t.inputSchema.properties.project));
    assert.equal((await client.listResources()).resources.length,1);
    assert.equal((await client.listPrompts()).prompts.length,1);
    const reference=await client.callTool({name:'scratchjr_block_reference',arguments:{}});
    assert.equal(reference.isError,undefined);
    assert(JSON.parse(reference.content[0].text).blocks.onflag);
    const state=await client.callTool({name:'scratchjr_status',arguments:{}});
    assert.equal(JSON.parse(state.content[0].text).connected,false);
    const bad=await client.callTool({name:'scratchjr_create_project',arguments:{project:{name:'bad',pages:[]}}});
    assert.equal(bad.isError,true);
  } finally {await client.close();}
});
