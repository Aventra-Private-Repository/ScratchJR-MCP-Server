// Covers the desktop assistant's provider layer: the per-provider settings, and
// the one client that has to serve four providers at once.
//
// The two local providers are the reason most of this exists. They need no key,
// their model list is whatever has been downloaded, their address can be moved,
// and they report their thinking inside the reply rather than in a field, so
// every one of those differences is pinned here against the hosted behaviour.
//
// desktop/src/ai is CommonJS and expects Electron, so it is loaded through a
// require with `electron` stubbed to a throwaway userData folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchjr-providers-'));

const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return load.apply(this, arguments);
};

const require_ = createRequire(import.meta.url);
const store = require_(path.join(here, '..', 'desktop', 'src', 'ai', 'settings.js'));
const { Agent } = require_(path.join(here, '..', 'desktop', 'src', 'ai', 'agent.js'));

// A stub the Agent can call tools on without an editor behind it.
const session = {
  toolDefinitions: () => [{ type: 'function', function: { name: 'scratchjr_connect', parameters: {} } }],
  call: async (name, args) => ({ text: `ran ${name} with ${JSON.stringify(args)}`, images: [], isError: false })
};

// Serves the OpenAI shape and records what it was sent. `reply(round)` returns
// the SSE frames for each round of the tool loop.
function stubProvider(reply, models = []) {
  const seen = { auth: [], bodies: [] };
  let round = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models.map(id => ({ id })) }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.auth.push(req.headers.authorization);
      seen.bodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of reply(++round)) res.write('data: ' + JSON.stringify(frame) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { seen, server, start: () => new Promise(done => server.listen(0, '127.0.0.1', done)),
           stop: () => new Promise(done => server.close(done)),
           port: () => server.address().port };
}

const delta = d => ({ choices: [{ delta: d }] });

test('an address is accepted in whatever form the server printed it', () => {
  assert.equal(store.normaliseBaseUrl('localhost:1234'), 'http://localhost:1234/v1');
  assert.equal(store.normaliseBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(store.normaliseBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(store.normaliseBaseUrl('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1');
  assert.equal(store.normaliseBaseUrl('https://box.lan:1234'), 'https://box.lan:1234/v1');
  assert.equal(store.normaliseBaseUrl('   '), '');
});

test('a settings file from before the per-provider maps keeps working', () => {
  fs.writeFileSync(path.join(userData, 'ai-settings.json'),
    JSON.stringify({ provider: 'deepseek', apiKey: 'sk-old', model: 'deepseek-v4-pro' }));
  const settings = store.read();
  assert.equal(store.apiKey(settings), 'sk-old');
  assert.equal(store.activeModel(settings), 'deepseek-v4-pro');
  // The key belonged to DeepSeek and must not be handed to anyone else.
  assert.equal(store.apiKey({ ...settings, provider: 'openrouter' }), '');
  assert.equal(store.activeModel({ ...settings, provider: 'openrouter' }), '~deepseek/deepseek-flash-latest');
});

test('saving one provider leaves the other three untouched', () => {
  store.write({ provider: 'lmstudio', models: { lmstudio: 'qwen3-8b' }, baseUrls: { lmstudio: 'localhost:9999' } });
  const settings = store.read();
  assert.equal(store.activeModel(settings), 'qwen3-8b');
  assert.equal(store.baseUrl(settings), 'http://localhost:9999/v1');
  assert.equal(store.apiKey({ ...settings, provider: 'deepseek' }), 'sk-old');
  assert.equal(store.activeModel({ ...settings, provider: 'deepseek' }), 'deepseek-v4-pro');
});

test('a local provider needs a model, not a key; a hosted one the reverse', () => {
  const settings = store.read();
  const lmstudio = { ...settings, provider: 'lmstudio' };
  assert.equal(store.isLocal(lmstudio), true);
  assert.equal(store.isConfigured(lmstudio), true);
  // Thinking is never asked for over the wire locally; it comes back in tags.
  assert.equal(store.isReasoningModel(lmstudio), false);

  const ollama = { ...settings, provider: 'ollama' };
  assert.equal(store.isConfigured(ollama), false);
  assert.equal(store.baseUrl(ollama), 'http://127.0.0.1:11434/v1');
  assert.match(store.setupMessage(ollama), /Ollama/);
  assert.match(store.setupMessage({ ...settings, provider: 'deepseek' }), /paste a DeepSeek key/);

  // Hosted thinking detection is unchanged.
  assert.equal(store.isReasoningModel({ ...settings, provider: 'deepseek' }), true);
  assert.equal(store.isReasoningModel({ ...settings, provider: 'deepseek', models: { deepseek: 'deepseek-flash' } }), false);
});

test('a hosted endpoint cannot be redirected by a stored address', () => {
  const meddled = { ...store.read(), provider: 'deepseek', baseUrls: { deepseek: 'http://elsewhere.example/v1' } };
  assert.equal(store.baseUrl(meddled), 'https://api.deepseek.com/v1');
});

test('a local provider is driven with no key, and its thinking is pulled out of the reply', async () => {
  const stub = stubProvider(round => round === 1 ? [
    // The tag is split across two frames, and the tool call arrives in pieces.
    delta({ content: 'Let me <thi' }),
    delta({ content: 'nk>pick a cat</think>Building it now.' }),
    delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'scratchjr_connect', arguments: '{"po' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'rt":1}' } }] })
  ] : [delta({ content: 'Done!' })], ['qwen3:8b', 'llama3.1:8b', 'qwen3:8b']);

  await stub.start();
  try {
    store.write({ provider: 'ollama', models: { ollama: 'qwen3:8b' }, baseUrls: { ollama: '127.0.0.1:' + stub.port() } });
    const settings = store.read();
    assert.equal(store.baseUrl(settings), `http://127.0.0.1:${stub.port()}/v1`);
    // Ollama can list the same model twice; the drop-down should not.
    assert.deepEqual(await store.listModels(settings), ['llama3.1:8b', 'qwen3:8b']);

    const events = [];
    await new Agent(session).run('make a cat story', event => events.push(event));
    const said = type => events.filter(e => e.type === type).map(e => e.text).join('');

    assert.equal(said('reasoning-delta'), 'pick a cat');
    assert.equal(said('assistant-delta'), 'Let me Building it now.Done!');
    assert.deepEqual(events.filter(e => e.type === 'tool').map(e => [e.name, e.args]),
      [['scratchjr_connect', { port: 1 }]]);

    assert.deepEqual(stub.seen.auth, [undefined, undefined], 'no bearer belongs on a local request');
    assert.equal(stub.seen.bodies.some(b => b.thinking || b.include_reasoning), false);
    // Local models are trained not to be shown their old thinking, and sending
    // it back would fill the context with it round after round.
    assert.equal(stub.seen.bodies[1].messages.some(m => m.reasoning_content), false);
    assert.deepEqual(stub.seen.bodies[1].messages.filter(m => m.role === 'assistant').map(m => m.content),
      ['Let me Building it now.']);
    assert.deepEqual(stub.seen.bodies[1].messages.filter(m => m.role === 'tool').map(m => m.content),
      ['ran scratchjr_connect with {"port":1}']);
  } finally {
    await stub.stop();
  }
});

test('the hosted path still sends the key, asks for thinking, and echoes it back', async () => {
  const stub = stubProvider(round => round === 1 ? [
    delta({ reasoning_content: 'weighing it up' }),
    delta({ content: 'A <think> block in the story text.' }),
    delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'scratchjr_connect', arguments: '{}' } }] })
  ] : [delta({ content: 'Finished.' })]);

  await stub.start();
  const real = store.PROVIDERS.deepseek.baseUrl;
  try {
    // Only a test may do this: the app refuses to redirect a hosted provider,
    // so the stub is swapped in on the provider table itself.
    store.PROVIDERS.deepseek.baseUrl = `http://127.0.0.1:${stub.port()}/v1`;
    store.write({ provider: 'deepseek', keys: { deepseek: 'sk-test' }, models: { deepseek: 'deepseek-v4-pro' } });

    const events = [];
    await new Agent(session).run('hello', event => events.push(event));
    const said = type => events.filter(e => e.type === type).map(e => e.text).join('');

    assert.deepEqual(stub.seen.auth, ['Bearer sk-test', 'Bearer sk-test']);
    assert.deepEqual(stub.seen.bodies[0].thinking, { type: 'enabled' });
    assert.equal(stub.seen.bodies[0].include_reasoning, undefined);
    assert.equal(said('reasoning-delta'), 'weighing it up');
    // The tag splitter must not run here: a <think> a child asked to have
    // written on screen is ordinary text coming from a hosted model.
    assert.equal(said('assistant-delta'), 'A <think> block in the story text.Finished.');
    assert.deepEqual(stub.seen.bodies[1].messages.filter(m => m.reasoning_content).map(m => m.reasoning_content),
      ['weighing it up']);
  } finally {
    store.PROVIDERS.deepseek.baseUrl = real;
    await stub.stop();
  }
});

test('a local server that is not running is explained rather than thrown raw', async () => {
  // Bound then closed, so the port is known to be free and refuses at once.
  const idle = http.createServer();
  await new Promise(done => idle.listen(0, '127.0.0.1', done));
  const port = idle.address().port;
  await new Promise(done => idle.close(done));

  store.write({ provider: 'lmstudio', models: { lmstudio: 'qwen3-8b' }, baseUrls: { lmstudio: '127.0.0.1:' + port } });
  await assert.rejects(
    new Agent(session).run('hello', () => {}),
    /Could not reach LM Studio at http:\/\/127\.0\.0\.1:\d+\/v1\. Open LM Studio/
  );
  await assert.rejects(store.listModels(store.read()), /Could not reach LM Studio/);
});
