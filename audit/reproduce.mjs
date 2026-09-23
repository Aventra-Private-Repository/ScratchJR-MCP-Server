// Offline audit probes. No API keys, provider calls, or live projects are used.
// Run from the repository root: node audit/reproduce.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

const settings = {
  read: () => ({provider: 'deepseek', apiKey: 'fake', maxRounds: 2}),
  isConfigured: () => true
};
const sandbox = {module: {exports: {}}, require: () => settings, TextDecoder};
vm.runInNewContext(fs.readFileSync('desktop/src/ai/agent.js', 'utf8'), sandbox);
const {Agent} = sandbox.module.exports;
const call = id => ({id, type: 'function', function: {name: 'scratchjr_status', arguments: '{}'}});

const streamAgent = new Agent({});
const frame = 'data: ' + JSON.stringify({choices: [{delta: {
  reasoning_content: 'Synthetic reasoning',
  tool_calls: [{index: 0, ...call('a')}]
}}]}) + '\n\ndata: [DONE]\n\n';
let consumed = false;
const message = await streamAgent.readStream({body: {getReader: () => ({
  read: async () => consumed ? {done: true} : (consumed = true, {done: false, value: Buffer.from(frame)}),
  cancel() {}
})}}, {label: 'Mock'}, () => {});
assert.equal(message.reasoning_content, undefined);
assert.equal(message.tool_calls.length, 1);
console.log('CONFIRMED: streamed reasoning is absent from returned assistant history.');

let agent;
agent = new Agent({call: async () => {
  agent.cancel();
  return {text: 'ok', images: [], isError: false};
}});
agent.complete = async () => ({role: 'assistant', content: '', tool_calls: [call('a'), call('b')]});
await agent.run('synthetic cancellation test', () => {});
const replied = agent.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
assert.deepEqual(Array.from(replied), ['a']);
assert.equal(agent.messages.find(m => m.tool_calls).tool_calls.length, 2);
console.log('CONFIRMED: stopping a batch leaves tool call b without a result in retained history.');

const {config: sourceConfig} = await import('../src/config.js');
const {config: bundledConfig} = await import('../desktop/mcp/src/config.js');
assert.notEqual(sourceConfig.backupDir, bundledConfig.backupDir);
console.log('CONFIRMED: source and bundled MCP servers use different default lock directories:');
console.log(sourceConfig.backupDir);
console.log(bundledConfig.backupDir);
const {withLock: sourceLock} = await import('../src/service.js');
const {withLock: bundledLock} = await import('../desktop/mcp/src/service.js');
let sourceHeld = false;
await sourceLock(async () => {
  sourceHeld = true;
  await bundledLock(async () => assert.equal(sourceHeld, true));
  sourceHeld = false;
});
console.log('CONFIRMED: both default locks can be held at once for the same debug port.');

const exe = path.resolve('desktop/node_modules/electron-prebuilt-compile/node_modules/electron/dist/electron.exe');
if (fs.existsSync(exe)) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchjr-audit-'));
  try {
    const code = "var fs=require('fs');console.log('Node '+process.versions.node);try{fs.mkdirSync(process.argv[1],{recursive:true});console.log('unexpected success')}catch(e){console.log(e.code)}";
    const result = spawnSync(exe, ['-e', code, temp], {
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
      encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /EEXIST/);
    console.log('CONFIRMED: bundled runtime rejects recursive mkdir when download directory exists.');
    console.log(result.stdout.trim());
  } finally {
    fs.rmdirSync(temp);
  }
}
