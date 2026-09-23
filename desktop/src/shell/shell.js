//
//  shell.js - the assistant panel that sits beside the editor.
//
//  The editor itself is a <webview>, which matters for two reasons: it gets its
//  own viewport, so ScratchJr lays out against the pane it is given, and it
//  stays its own debugger target so the MCP server attaches to the editor
//  rather than to this page.
//
//  The panel is a side bar on the right. It can be dragged wider, folded away
//  behind the edge tab, and while a turn is running it shows what the model is
//  doing rather than going quiet until the answer lands.

const path = require('path');
const {ipcRenderer} = require('electron');

const settingsStore = require(path.join(__dirname, '..', 'ai', 'settings.js'));
const {McpSession} = require(path.join(__dirname, '..', 'ai', 'mcp.js'));
const {Agent} = require(path.join(__dirname, '..', 'ai', 'agent.js'));
const nodeRuntime = require(path.join(__dirname, '..', 'ai', 'node-runtime.js'));
const {ensureNode} = nodeRuntime;
const attachments = require(path.join(__dirname, '..', 'ai', 'attachments.js'));
const log = require(path.join(__dirname, '..', 'log.js'));
const {resolveServerPath} = require(path.join(__dirname, '..', 'ai', 'mcp.js'));

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
const assistToggle = document.getElementById('assist-toggle');
const resizer = document.getElementById('resizer');
const activity = document.getElementById('activity');
const activityText = document.getElementById('activity-text');
const activityMeta = document.getElementById('activity-meta');
const attachButton = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachmentBar = document.getElementById('attachments');

// ScratchJr's own frame stops at 766px wide; the panel is not allowed to push
// the editor below that, however wide the window is.
const EDITOR_MIN_WIDTH = 766;
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 640;

let session = null;
let agent = null;
let busy = false;

/* ---------- panel size and visibility ---------- */

function panelWidth() {
  const raw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w'), 10);
  return isNaN(raw) ? wantedWidth : raw;
}

function clampPanelWidth(width) {
  const room = Math.max(PANEL_MIN_WIDTH, window.innerWidth - EDITOR_MIN_WIDTH);
  return Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(width, PANEL_MAX_WIDTH, room)));
}

// The width that was asked for, which is not always the width that fits. A
// narrow window squeezes the panel, and widening it again gives the width back
// rather than leaving the panel stuck at whatever the tightest moment allowed.
let wantedWidth = 380;

function applyPanelWidth() {
  document.documentElement.style.setProperty('--panel-w', clampPanelWidth(wantedWidth) + 'px');
}

function setPanelWidth(width) {
  wantedWidth = Math.round(width);
  applyPanelWidth();
}

// The width the panel is asking the window for. While the panel is shut the
// window is narrow, so the width that currently fits is smaller than the one
// that will be wanted once it opens - reporting the fitted width here would
// make the window grow back by less than it gave away.
function intendedWidth() {
  return Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(wantedWidth, PANEL_MAX_WIDTH)));
}

// The main process widens the window when the panel opens and narrows it again
// when it shuts, so the editor keeps its room instead of being squeezed. A drag
// reports what is on screen, since that is already the width being asked for.
function reportLayout(reason) {
  ipcRenderer.send('assistant-layout', {
    visible: assistantVisible(),
    width: reason === 'drag' ? panelWidth() : intendedWidth(),
    editorMinWidth: EDITOR_MIN_WIDTH,
    reason: reason
  });
}

function assistantVisible() {
  return !document.body.classList.contains('assistant-hidden');
}

function setAssistantVisible(visible) {
  document.body.classList.toggle('assistant-hidden', !visible);
  assistToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
  assistToggle.title = visible ? 'Hide the assistant' : 'Show the assistant';
  if (visible) assistToggle.classList.remove('has-news');
}

// Anything arriving while the panel is shut would otherwise go unnoticed.
function flagUnread() {
  if (!assistantVisible()) assistToggle.classList.add('has-news');
}

assistToggle.addEventListener('click', () => {
  const visible = !assistantVisible();
  log.info(visible ? 'Assistant panel opened' : 'Assistant panel hidden');
  setAssistantVisible(visible);
  settingsStore.write({assistantVisible: visible});
  reportLayout('toggle');
  if (visible && !busy) input.focus();
});

/* ---------- dragging the edge ---------- */

let dragging = false;

resizer.addEventListener('mousedown', event => {
  event.preventDefault();
  dragging = true;
  document.body.classList.add('resizing');
});

window.addEventListener('mousemove', event => {
  if (!dragging) return;
  setPanelWidth(window.innerWidth - event.clientX);
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('resizing');
  settingsStore.write({assistantWidth: panelWidth()});
  reportLayout('drag');
});

// A window that shrank under the panel would squeeze the editor, so the panel
// gives way instead.
window.addEventListener('resize', applyPanelWidth);

/* ---------- transcript rendering ---------- */

// Streaming should not fight someone reading back through the transcript, so
// it only follows along while they are already at the bottom.
let stick = true;
transcript.addEventListener('scroll', () => {
  const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  stick = distance < 40;
});

function scrollToEnd(force) {
  if (!stick && !force) return;
  transcript.scrollTop = transcript.scrollHeight;
}

function hideEmptyState() {
  if (emptyState && emptyState.parentNode) emptyState.parentNode.removeChild(emptyState);
}

function addTurn(role, text) {
  flagUnread();
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
  scrollToEnd(role === 'user');
  return turn;
}

/* ---------- the streaming reply ---------- */

// One object per assistant reply: the bubble the words arrive in, and the
// folded block its thinking arrives in.
let streamingTurn = null;
let thinkingBlock = null;

function appendAssistantDelta(text) {
  if (!streamingTurn) {
    flagUnread();
    const turn = addTurn('assistant', '');
    turn.classList.add('streaming');
    streamingTurn = {turn: turn, bubble: turn.querySelector('.bubble')};
    // The answer has started, so the working that led to it can fold away.
    if (thinkingBlock) thinkingBlock.row.open = false;
  }
  streamingTurn.bubble.textContent += text;
  scrollToEnd();
}

function finishAssistantTurn() {
  if (!streamingTurn) return;
  streamingTurn.turn.classList.remove('streaming');
  streamingTurn = null;
}

function appendReasoningDelta(text) {
  if (!thinkingBlock) {
    flagUnread();
    hideEmptyState();
    const row = document.createElement('details');
    row.className = 'thinking';
    row.open = true;

    const summary = document.createElement('summary');
    summary.textContent = 'Thinking...';

    const body = document.createElement('pre');
    row.appendChild(summary);
    row.appendChild(body);
    transcript.appendChild(row);
    thinkingBlock = {row: row, summary: summary, body: body};
  }
  thinkingBlock.body.textContent += text;
  scrollToEnd();
}

function finishThinking() {
  if (!thinkingBlock) return;
  thinkingBlock.summary.textContent = 'Thought it through';
  thinkingBlock = null;
}

/* ---------- tool activity ---------- */

const toolRows = new Map();

function addToolRow(event) {
  flagUnread();
  hideEmptyState();
  finishAssistantTurn();
  const row = document.createElement('details');
  row.className = 'tool running';

  const summary = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('code');
  label.textContent = event.name.replace(/^scratchjr_/, '');
  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = ' running...';
  const took = document.createElement('span');
  took.className = 'took';
  summary.appendChild(dot);
  summary.appendChild(label);
  summary.appendChild(state);
  summary.appendChild(took);

  const body = document.createElement('pre');
  const argText = JSON.stringify(event.args, null, 2);
  body.textContent = argText === '{}' ? '(no arguments)' : argText;

  row.appendChild(summary);
  row.appendChild(body);
  transcript.appendChild(row);
  scrollToEnd();
  toolRows.set(event.id, {row: row, state: state, took: took, body: body, started: Date.now()});
}

function finishToolRow(event) {
  const entry = toolRows.get(event.id);
  if (!entry) return;
  entry.row.classList.remove('running');
  entry.state.textContent = event.isError ? ' failed' : ' done';
  entry.took.textContent = formatDuration(Date.now() - entry.started);
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

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

/* ---------- the activity strip ---------- */

// What the panel says it is doing, and for how long. The clock matters most on
// a slow reasoning model, where nothing else moves for several seconds.
let turnStarted = 0;
let clock = null;
let roundLabel = '';

function setActivity(text) {
  activityText.textContent = text;
}

function refreshActivityMeta() {
  const seconds = Math.round((Date.now() - turnStarted) / 1000);
  activityMeta.textContent = roundLabel ? `${roundLabel} - ${seconds}s` : `${seconds}s`;
}

function startActivity() {
  turnStarted = Date.now();
  roundLabel = '';
  setActivity('Waiting for the model');
  refreshActivityMeta();
  activity.classList.remove('hidden');
  clock = setInterval(refreshActivityMeta, 1000);
}

function stopActivity() {
  if (clock) { clearInterval(clock); clock = null; }
  activity.classList.add('hidden');
}

/* ---------- state ---------- */

function refreshStatus() {
  const settings = settingsStore.read();
  const provider = settingsStore.PROVIDERS[settings.provider];
  if (settingsStore.isConfigured(settings)) {
    const thinks = settingsStore.isReasoningModel(settings) ? ' - thinks first' : '';
    modelLabel.textContent = `${provider.label} - ${settingsStore.activeModel(settings)}${thinks}`;
    spark.classList.add('ready');
    input.placeholder = 'Ask for a story...';
  } else {
    modelLabel.textContent = 'Not configured';
    spark.classList.remove('ready');
    input.placeholder = 'Add an API key in Settings...';
  }
  const hint = document.getElementById('setup-hint');
  if (hint) hint.style.display = settingsStore.isConfigured(settings) ? 'none' : '';
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  attachButton.disabled = value;
  input.disabled = value;
  spark.classList.toggle('busy', value);
  if (value) startActivity(); else stopActivity();
  if (!value && assistantVisible()) { input.focus(); }
}

// Asked before anything is downloaded. Yes fetches a copy for this app alone,
// No leaves the machine untouched and says so in the panel.
function askToInstallNode(existing) {
  const {remote} = require('electron');
  const question = existing
    ? `Node.js ${existing.version} is installed, but the assistant needs version ${nodeRuntime.MINIMUM_MAJOR} or newer.`
    : 'The assistant needs Node.js to run the ScratchJr tools, and it is not installed on this computer.';

  const choice = remote.dialog.showMessageBox(remote.getCurrentWindow(), {
    type: 'question',
    buttons: ['Install now', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Something is missing',
    message: question,
    detail: 'Install a copy for this app only?\n\nIt downloads about 36 MB into the app\'s own folder. It needs no administrator rights, changes nothing about the rest of the computer, leaves any Node.js already installed alone, and is removed when this app is uninstalled.'
  });
  return choice === 0;
}

async function ensureSession(report) {
  if (session && agent) return;
  const settings = settingsStore.read();

  // Said plainly rather than as a failure halfway through a story: without the
  // tool server there is nothing for the assistant to drive.
  if (!resolveServerPath(settings.mcpServerPath)) {
    const {remote} = require('electron');
    log.error('The MCP tool server was not found', {configured: settings.mcpServerPath || '(auto)'});
    remote.dialog.showMessageBox(remote.getCurrentWindow(), {
      type: 'error',
      buttons: ['OK'],
      title: 'Something is missing',
      message: 'The ScratchJr tool server was not found.',
      detail: 'This part of the app builds the projects. Open File > Settings > Advanced and point "ScratchJr tool server" at src/server.js, or reinstall the app.'
    });
    throw new Error('The ScratchJr MCP server was not found. Set its path to src/server.js in File > Settings.');
  }

  // The tool server needs Node 22+. If the machine has none, one is offered
  // rather than installed behind anyone's back.
  const node = await ensureNode(settings, report, askToInstallNode);
  session = new McpSession(settings, node.path);
  await session.start();
  agent = new Agent(session);
  log.info('Assistant session ready', {node: node.version, tools: session.tools.length});
}

/* ---------- attached documents ---------- */

// What is waiting to go with the next message. Each entry is a file that has
// already been read, so sending costs nothing but the sending.
let attached = [];

function describeSize(file) {
  if (file.chars < 1000) return file.chars + ' characters';
  return Math.round(file.chars / 100) / 10 + 'k characters' + (file.truncated ? ', cut short' : '');
}

function renderAttachments() {
  attachmentBar.innerHTML = '';
  attachmentBar.classList.toggle('hidden', !attached.length);

  for (const file of attached) {
    const chip = document.createElement('div');
    chip.className = 'attachment';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = describeSize(file);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.title = 'Take this file off the message';
    drop.textContent = '×';
    drop.addEventListener('click', () => {
      attached = attached.filter(other => other !== file);
      renderAttachments();
    });

    chip.appendChild(name);
    chip.appendChild(size);
    chip.appendChild(drop);
    attachmentBar.appendChild(chip);
  }
}

async function attachFiles(paths) {
  for (const filePath of paths) {
    if (attached.some(file => file.path === filePath)) continue;
    try {
      const file = await attachments.read(filePath);
      attached.push(file);
      renderAttachments();
      log.info('Document attached', {name: file.name, kind: file.kind, characters: file.chars, truncated: file.truncated});
    } catch (error) {
      log.warn('Document could not be attached', {file: filePath, reason: error.message});
      addTurn('error', error.message);
    }
  }
}

attachButton.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  // In Electron a chosen File carries the path it came from, which is what the
  // reader needs; the browser's own File contents are not used.
  const paths = [].slice.call(fileInput.files).map(file => file.path);
  fileInput.value = '';
  await attachFiles(paths);
});

// Dropping onto the panel does the same thing. The editor beside it keeps its
// own drag behaviour, so only this pane lights up.
const panel = document.getElementById('assistant');

panel.addEventListener('dragover', event => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('dropping');
});

panel.addEventListener('dragleave', event => {
  if (event.target === panel || !panel.contains(event.relatedTarget)) {
    document.body.classList.remove('dropping');
  }
});

panel.addEventListener('drop', async event => {
  event.preventDefault();
  document.body.classList.remove('dropping');
  const dropped = [].slice.call(event.dataTransfer.files).map(file => file.path).filter(Boolean);
  const usable = dropped.filter(attachments.isSupported);
  for (const filePath of dropped.filter(file => !attachments.isSupported(file))) {
    addTurn('error', `${path.basename(filePath)} is not a kind of file the assistant can read. Use .md, .txt or .pdf.`);
  }
  await attachFiles(usable);
});

/* ---------- sending ---------- */

async function send(text) {
  const sending = attached;
  if (busy || (!text.trim() && !sending.length)) return;
  stick = true;
  addTurn('user', describeSentMessage(text.trim(), sending));
  input.value = '';
  input.style.height = 'auto';

  // Checked here rather than at the end of the chain: starting the tool server
  // can mean downloading Node, which is a lot to do before finding out that
  // there is no key to send anything with.
  if (!settingsStore.isConfigured(settingsStore.read())) {
    addTurn('error', 'No API key yet. Open File > Settings and paste a DeepSeek or OpenRouter key.');
    return;
  }

  stopRequested = false;
  setBusy(true);
  const settings = settingsStore.read();
  log.info('Message sent', {
    characters: text.trim().length,
    attachments: sending.map(file => `${file.name} (${file.chars} chars)`),
    provider: settings.provider,
    model: settingsStore.activeModel(settings)
  });

  try {
    setActivity('Starting the tool server');
    await ensureSession(report => addTurn('assistant', report));
    if (stopRequested) { addTurn('assistant', 'Stopped.'); return; }
    // The documents ride ahead of the message, and only the once: they are
    // already in the conversation after this turn.
    attached = [];
    renderAttachments();
    await agent.run(attachments.toPrompt(sending, text.trim()), handleAgentEvent);
  } catch (error) {
    finishAssistantTurn();
    finishThinking();
    log[error.declined ? 'warn' : 'error']('Message failed', error.declined ? error.message : error);
    addTurn('error', error.message);
    // A failed handshake leaves nothing worth reusing; start clean next time.
    if (session && !session.child) { session = null; agent = null; }
  } finally {
    finishAssistantTurn();
    finishThinking();
    log.info('Turn finished', {seconds: Math.round((Date.now() - turnStarted) / 1000)});
    setBusy(false);
  }
}

// The transcript shows the child's own words plus the names of what went with
// them, never the whole document pasted back at them.
function describeSentMessage(text, files) {
  if (!files.length) return text;
  const names = files.map(file => file.name).join(', ');
  return text ? `${text}

(sent with ${names})` : `(sent ${names})`;
}

function handleAgentEvent(event) {
  switch (event.type) {
  case 'round':
    roundLabel = `round ${event.round}/${event.of}`;
    setActivity('Waiting for the model');
    refreshActivityMeta();
    break;
  case 'reasoning-delta':
    setActivity('Thinking');
    appendReasoningDelta(event.text);
    break;
  case 'reasoning-done':
    finishThinking();
    break;
  case 'assistant-delta':
    setActivity('Writing the reply');
    appendAssistantDelta(event.text);
    break;
  case 'assistant-done':
    finishAssistantTurn();
    break;
  case 'tool':
    setActivity(`Using ${event.name.replace(/^scratchjr_/, '')}`);
    addToolRow(event);
    break;
  case 'tool-result':
    setActivity('Waiting for the model');
    finishToolRow(event);
    break;
  case 'notice':
    finishAssistantTurn();
    addTurn('assistant', event.text);
    break;
  default:
    break;
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

// Stop can be pressed before there is an agent to stop - the first message of
// a session spends its first seconds starting the tool server - so the request
// is remembered and send() checks it on the way through.
let stopRequested = false;

stopButton.addEventListener('click', () => {
  log.info('Stop pressed');
  stopRequested = true;
  if (agent) agent.cancel();
  setActivity('Stopping');
});

settingsButton.addEventListener('click', () => ipcRenderer.send('open-ai-settings'));

clearButton.addEventListener('click', () => {
  if (busy) return;
  log.info('New chat started');
  if (agent) agent.reset();
  transcript.innerHTML = '';
  toolRows.clear();
  streamingTurn = null;
  thinkingBlock = null;
  attached = [];
  renderAttachments();
  if (emptyState) transcript.appendChild(emptyState);
  refreshStatus();
});

ipcRenderer.on('ai-settings-changed', () => {
  log.info('Settings changed; the tool server will be restarted on the next message');
  // The next turn should use the new provider, so drop the old server session.
  if (session) session.stop();
  session = null;
  agent = null;
  refreshStatus();
});

window.addEventListener('beforeunload', () => { if (session) session.stop(); });

// Anything the panel itself throws would otherwise be lost with the window.
window.addEventListener('error', event => {
  log.error('Unhandled error in the assistant panel', event.error || event.message);
});

const startup = settingsStore.read();
setPanelWidth(startup.assistantWidth || 380);
setAssistantVisible(startup.assistantVisible !== false);
refreshStatus();
reportLayout('startup');
log.info('Assistant panel ready', {
  configured: settingsStore.isConfigured(startup),
  provider: startup.provider,
  model: settingsStore.activeModel(startup),
  panelVisible: startup.assistantVisible !== false,
  panelWidth: panelWidth()
});
