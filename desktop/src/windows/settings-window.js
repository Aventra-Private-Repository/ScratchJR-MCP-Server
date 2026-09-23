// Settings window: provider, key, model, and the two advanced paths.

const path = require('path');
const electron = require('electron');
const {ipcRenderer, shell} = electron;

const settingsStore = require(path.join(__dirname, '..', 'ai', 'settings.js'));
const {resolveServerPath} = require(path.join(__dirname, '..', 'ai', 'mcp.js'));
const nodeRuntime = require(path.join(__dirname, '..', 'ai', 'node-runtime.js'));

const providersEl = document.getElementById('providers');
const keyEl = document.getElementById('key');
const revealEl = document.getElementById('reveal');
const keyLinkEl = document.getElementById('key-link');
const modelEl = document.getElementById('model');
const modelChoiceEl = document.getElementById('model-choice');
const modelHintEl = document.getElementById('model-hint');
const roundsEl = document.getElementById('rounds');
const nodeEl = document.getElementById('node');
const nodeHintEl = document.getElementById('node-hint');
const installNodeEl = document.getElementById('install-node');
const serverEl = document.getElementById('server');
const serverHintEl = document.getElementById('server-hint');
const statusEl = document.getElementById('status');

let current = settingsStore.read();

for (const id of Object.keys(settingsStore.PROVIDERS)) {
  const provider = settingsStore.PROVIDERS[id];
  const label = document.createElement('label');
  label.dataset.provider = id;
  label.innerHTML =
    `<input type="radio" name="provider" value="${id}">` +
    `<span class="name">${provider.label}</span>` +
    `<span class="url">${provider.baseUrl.replace('https://', '')}</span>`;
  label.addEventListener('click', () => selectProvider(id));
  providersEl.appendChild(label);
}

function selectProvider(id) {
  current.provider = id;
  const provider = settingsStore.PROVIDERS[id];
  for (const label of providersEl.querySelectorAll('label')) {
    const picked = label.dataset.provider === id;
    label.classList.toggle('picked', picked);
    label.querySelector('input').checked = picked;
  }
  modelEl.placeholder = provider.defaultModel;
  modelHintEl.textContent = provider.modelHint;
  keyLinkEl.textContent = provider.keyUrl;
  keyLinkEl.onclick = () => shell.openExternal(provider.keyUrl);
  fillModels(provider, settingsStore.activeModel(current));
}

// The drop-down carries the models worth picking; anything else the provider
// offers can still be typed in, which is what the last entry is for.
const CUSTOM = '__custom__';

function fillModels(provider, chosen) {
  modelChoiceEl.innerHTML = '';
  for (const model of provider.models || []) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    modelChoiceEl.appendChild(option);
  }
  const other = document.createElement('option');
  other.value = CUSTOM;
  other.textContent = 'Something else - type the id below';
  modelChoiceEl.appendChild(other);

  const known = (provider.models || []).some(model => model.id === chosen);
  modelChoiceEl.value = known ? chosen : CUSTOM;
  modelEl.value = known ? '' : chosen;
  showCustomModel(!known);
}

function showCustomModel(show) {
  modelEl.style.display = show ? '' : 'none';
}

// What the next message will actually be sent to.
function chosenModel() {
  return modelChoiceEl.value === CUSTOM ? modelEl.value.trim() : modelChoiceEl.value;
}

modelChoiceEl.addEventListener('change', () => {
  const custom = modelChoiceEl.value === CUSTOM;
  showCustomModel(custom);
  if (custom) modelEl.focus();
});

function load() {
  current = settingsStore.read();
  keyEl.value = current.apiKey || '';
  // selectProvider fills the model drop-down, so it runs after the stored
  // model is known and before anything reads the boxes back.
  selectProvider(current.provider);
  roundsEl.value = current.maxRounds;
  nodeEl.value = current.nodePath || '';
  serverEl.value = current.mcpServerPath || '';

  refreshNodeStatus();

  const detected = resolveServerPath(current.mcpServerPath);
  serverHintEl.textContent = detected
    ? `Found: ${detected}`
    : 'Not found automatically. The assistant cannot run tools until this points at src/server.js.';
}

// Says what will actually happen on the next message, rather than what is
// configured: a blank box with no Node on the machine means a download.
function refreshNodeStatus() {
  const found = nodeRuntime.findNode({nodePath: nodeEl.value.trim()});
  if (found && found.ok) {
    nodeHintEl.textContent = `Using Node ${found.version} at ${found.path}. Leave blank to keep detecting it automatically.`;
    installNodeEl.textContent = 'Reinstall';
  } else if (found) {
    nodeHintEl.textContent = `Node ${found.version} is older than ${nodeRuntime.MINIMUM_MAJOR}, which the tools need. A newer copy will be downloaded for this app alone when you first send a message.`;
    installNodeEl.textContent = 'Install now';
  } else {
    nodeHintEl.textContent = `No Node.js found. One will be downloaded into this app's own folder when you first send a message, without touching the rest of the computer.`;
    installNodeEl.textContent = 'Install now';
  }
}

nodeEl.addEventListener('change', refreshNodeStatus);

installNodeEl.addEventListener('click', async () => {
  installNodeEl.disabled = true;
  try {
    const installed = await nodeRuntime.installNode(text => { statusEl.textContent = text; });
    nodeEl.value = installed.path;
    statusEl.textContent = `Node ${installed.version} installed`;
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    installNodeEl.disabled = false;
    refreshNodeStatus();
  }
});

revealEl.addEventListener('click', () => {
  const hidden = keyEl.type === 'password';
  keyEl.type = hidden ? 'text' : 'password';
  revealEl.textContent = hidden ? 'Hide' : 'Show';
});

document.getElementById('cancel').addEventListener('click', () => window.close());

document.getElementById('save').addEventListener('click', () => {
  const rounds = Math.max(1, Math.min(40, Number(roundsEl.value) || 12));
  settingsStore.write({
    provider: current.provider,
    apiKey: keyEl.value.trim(),
    model: chosenModel(),
    maxRounds: rounds,
    nodePath: nodeEl.value.trim(),
    mcpServerPath: serverEl.value.trim()
  });
  statusEl.textContent = 'Saved';
  ipcRenderer.send('ai-settings-saved');
  setTimeout(() => window.close(), 250);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});

load();
