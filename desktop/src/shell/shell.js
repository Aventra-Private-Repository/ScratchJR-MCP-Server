//
//  shell.js - the assistant panel that sits under the editor.
//
//  The editor itself is a <webview>, which matters for two reasons: it gets its
//  own viewport, sized for ScratchJr rather than for whatever is left of the
//  window, and it stays its own debugger target so the MCP server attaches to
//  the editor rather than to this page.

const path = require('path');
const {ipcRenderer} = require('electron');

const settingsStore = require(path.join(__dirname, '..', 'ai', 'settings.js'));
const {McpSession} = require(path.join(__dirname, '..', 'ai', 'mcp.js'));
const {Agent} = require(path.join(__dirname, '..', 'ai', 'agent.js'));
const {ensureNode} = require(path.join(__dirname, '..', 'ai', 'node-runtime.js'));

const transcript = document.getElementById('transcript');
const emptyState = document.getElementById('empty-state');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendButton = document.getElementById('send-btn');
const stopButton = document.getElementById('stop-btn');
const clearButton = document.getElementById('clear-btn');
const settingsButton = document.getElementById('settings-btn');
const modelLabel = document.getElementById('model-label');
const spark = document.querySelector('.spark');

let session = null;
let agent = null;
let busy = false;

/* ---------- transcript rendering ---------- */

function scrollToEnd() { transcript.scrollTop = transcript.scrollHeight; }

function hideEmptyState() {
  if (emptyState && emptyState.parentNode) emptyState.parentNode.removeChild(emptyState);
}

function addTurn(role, text) {
  hideEmptyState();
  const turn = document.createElement('div');
  turn.className = 'turn ' + role;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'You' : role === 'error' ? 'Problem' : 'Assistant';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  turn.appendChild(who);
  turn.appendChild(bubble);
  transcript.appendChild(turn);
  scrollToEnd();
  return turn;
}

const toolRows = new Map();

function addToolRow(event) {
  hideEmptyState();
  const row = document.createElement('details');
  row.className = 'tool';

  const summary = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('code');
  label.textContent = event.name.replace(/^scratchjr_/, '');
  const state = document.createElement('span');
  state.textContent = ' running...';
  summary.appendChild(dot);
  summary.appendChild(label);
  summary.appendChild(state);

  const body = document.createElement('pre');
  const argText = JSON.stringify(event.args, null, 2);
  body.textContent = argText === '{}' ? '(no arguments)' : argText;

  row.appendChild(summary);
  row.appendChild(body);
  transcript.appendChild(row);
  scrollToEnd();
  toolRows.set(event.id, {row: row, state: state, body: body});
}

function finishToolRow(event) {
  const entry = toolRows.get(event.id);
  if (!entry) return;
  entry.state.textContent = event.isError ? ' failed' : ' done';
  if (event.isError) entry.row.classList.add('failed');

  if (event.text) {
    const output = document.createElement('pre');
    output.textContent = event.text.length > 4000 ? event.text.slice(0, 4000) + '\n... truncated' : event.text;
    entry.row.appendChild(output);
  }
  for (const image of event.images || []) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = `data:${image.mimeType || 'image/png'};base64,${image.data}`;
    entry.row.appendChild(img);
  }
  if (event.isError) entry.row.open = true;
  scrollToEnd();
}

/* ---------- state ---------- */

function refreshStatus() {
  const settings = settingsStore.read();
  const provider = settingsStore.PROVIDERS[settings.provider];
  if (settingsStore.isConfigured(settings)) {
    modelLabel.textContent = `${provider.label} · ${settingsStore.activeModel(settings)}`;
    spark.classList.add('ready');
    input.placeholder = 'Describe the story you want to build...';
  } else {
    modelLabel.textContent = 'Not configured';
    spark.classList.remove('ready');
    input.placeholder = 'Add an API key in File > Settings to start...';
  }
  const hint = document.getElementById('setup-hint');
  if (hint) hint.style.display = settingsStore.isConfigured(settings) ? 'none' : '';
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  input.disabled = value;
  stopButton.classList.toggle('hidden', !value);
  spark.classList.toggle('busy', value);
  if (!value) { input.focus(); }
}

async function ensureSession(report) {
  if (session && agent) return;
  const settings = settingsStore.read();
  // The tool server needs Node 22+. If the machine has none, one is fetched
  // into this app's own folder rather than asking the family to install it.
  const node = await ensureNode(settings, report);
  session = new McpSession(settings, node.path);
  await session.start();
  agent = new Agent(session);
}

/* ---------- sending ---------- */

async function send(text) {
  if (busy || !text.trim()) return;
  addTurn('user', text.trim());
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);

  try {
    await ensureSession(text => addTurn('assistant', text));
    await agent.run(text.trim(), event => {
      if (event.type === 'assistant') addTurn('assistant', event.text);
      else if (event.type === 'tool') addToolRow(event);
      else if (event.type === 'tool-result') finishToolRow(event);
      else if (event.type === 'notice') addTurn('assistant', event.text);
    });
  } catch (error) {
    addTurn('error', error.message);
    // A failed handshake leaves nothing worth reusing; start clean next time.
    if (session && !session.child) { session = null; agent = null; }
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  send(input.value);
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send(input.value);
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => send(chip.textContent));
}

stopButton.addEventListener('click', () => { if (agent) agent.cancel(); });
settingsButton.addEventListener('click', () => ipcRenderer.send('open-ai-settings'));

clearButton.addEventListener('click', () => {
  if (busy) return;
  if (agent) agent.reset();
  transcript.innerHTML = '';
  if (emptyState) transcript.appendChild(emptyState);
  refreshStatus();
});

ipcRenderer.on('ai-settings-changed', () => {
  // The next turn should use the new provider, so drop the old server session.
  if (session) session.stop();
  session = null;
  agent = null;
  refreshStatus();
});

window.addEventListener('beforeunload', () => { if (session) session.stop(); });

refreshStatus();
