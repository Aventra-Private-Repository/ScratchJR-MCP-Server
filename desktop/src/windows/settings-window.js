// Settings window: provider, key, model, and the two advanced paths.

const path = require('path');
const electron = require('electron');
const {ipcRenderer, shell} = electron;

const settingsStore = require(path.join(__dirname, '..', 'ai', 'settings.js'));
const {resolveServerPath} = require(path.join(__dirname, '..', 'ai', 'mcp.js'));
const nodeRuntime = require(path.join(__dirname, '..', 'ai', 'node-runtime.js'));

const providersEl = document.getElementById('providers');
const bannerEl = document.getElementById('banner');
const keyFieldEl = document.getElementById('key-field');
const keyEl = document.getElementById('key');
const revealEl = document.getElementById('reveal');
const keyLinkEl = document.getElementById('key-link');
const addressFieldEl = document.getElementById('address-field');
const addressEl = document.getElementById('address');
const addressHintEl = document.getElementById('address-hint');
const testEl = document.getElementById('test');
const modelEl = document.getElementById('model');
const modelChoiceEl = document.getElementById('model-choice');
const modelHintEl = document.getElementById('model-hint');
const refreshModelsEl = document.getElementById('refresh-models');
const roundsEl = document.getElementById('rounds');
const nodeEl = document.getElementById('node');
const nodeHintEl = document.getElementById('node-hint');
const installNodeEl = document.getElementById('install-node');
const serverEl = document.getElementById('server');
const serverHintEl = document.getElementById('server-hint');
const statusEl = document.getElementById('status');

let current = settingsStore.read();
let selected = current.provider;

// What each local provider answered when last asked for its models. Held here
// rather than saved: the list is only true while that server is running, and a
// stale copy written to disk would offer models that have since been deleted.
const discovered = {};

const HOSTED_BANNER = 'The key is stored in plain text on this computer, and every message you send costs money on your own account. Do not share this machine\'s settings file.';
const LOCAL_BANNER = 'This provider runs on this computer. Nothing is sent over the internet and no account or key is needed, but the model has to be running before the assistant can use it.';

for (const id of Object.keys(settingsStore.PROVIDERS)) {
  const provider = settingsStore.PROVIDERS[id];
  const label = document.createElement('label');
  label.dataset.provider = id;
  label.innerHTML =
    `<input type="radio" name="provider" value="${id}">` +
    (provider.local ? '<span class="tag">on this PC</span>' : '') +
    `<span class="name">${provider.label}</span>` +
    `<span class="url">${provider.baseUrl.replace(/^https?:\/\//, '')}</span>`;
  label.addEventListener('click', () => selectProvider(id));
  providersEl.appendChild(label);
}

// Everything typed for the provider being left is kept, so flicking between
// two of them to compare does not throw away a key or an address.
function rememberCurrentProvider() {
  const provider = settingsStore.PROVIDERS[selected];
  current.models[selected] = chosenModel();
  if (provider.local) current.baseUrls[selected] = addressEl.value.trim();
  else current.keys[selected] = keyEl.value.trim();
}

function selectProvider(id) {
  if (id !== selected) rememberCurrentProvider();
  selected = id;
  current.provider = id;
  paintProvider();
}

function paintProvider() {
  const provider = settingsStore.PROVIDERS[selected];
  const local = Boolean(provider.local);

  for (const label of providersEl.querySelectorAll('label')) {
    const picked = label.dataset.provider === selected;
    label.classList.toggle('picked', picked);
    label.querySelector('input').checked = picked;
  }

  bannerEl.textContent = local ? LOCAL_BANNER : HOSTED_BANNER;
  keyFieldEl.style.display = local ? 'none' : '';
  addressFieldEl.style.display = local ? '' : 'none';
  refreshModelsEl.style.display = local ? '' : 'none';
  // A refresh still in flight when the provider was switched never re-enables
  // its button, since by then it is answering about somebody else.
  refreshModelsEl.disabled = false;

  keyEl.value = current.keys[selected] || '';
  keyLinkEl.textContent = provider.keyUrl;
  keyLinkEl.onclick = () => shell.openExternal(provider.keyUrl);

  addressEl.value = current.baseUrls[selected] || '';
  addressEl.placeholder = provider.baseUrl;
  addressHintEl.textContent = provider.setupHint || '';

  modelEl.placeholder = provider.defaultModel || 'Model id';
  modelHintEl.textContent = provider.modelHint;
  fillModels(modelsFor(provider), storedModel());
  if (local) refreshModels(true);
}

// The model the boxes should open on: what was chosen for this provider before,
// or the provider's default where it has one.
function storedModel() {
  return (current.models[selected] || '').trim() || settingsStore.PROVIDERS[selected].defaultModel || '';
}

// A hosted provider has a written list of the models worth picking. A local one
// has whatever it answered when asked, and nothing at all until it is.
function modelsFor(provider) {
  if (!provider.local) return provider.models || [];
  return (discovered[selected] || []).map(id => ({id: id, label: id}));
}

// The drop-down carries the models worth picking; anything else the provider
// offers can still be typed in, which is what the last entry is for.
const CUSTOM = '__custom__';

function fillModels(models, chosen) {
  modelChoiceEl.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    modelChoiceEl.appendChild(option);
  }
  const other = document.createElement('option');
  other.value = CUSTOM;
  other.textContent = 'Something else - type the id below';
  modelChoiceEl.appendChild(other);

  const known = models.some(model => model.id === chosen);
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

// A settings object standing for what is in the boxes right now, so the server
// can be asked about an address that has been typed but not yet saved.
function draft() {
  const keys = Object.assign({}, current.keys);
  const baseUrls = Object.assign({}, current.baseUrls);
  keys[selected] = keyEl.value.trim();
  baseUrls[selected] = addressEl.value.trim();
  return Object.assign({}, current, {provider: selected, keys: keys, baseUrls: baseUrls});
}

// Asks a local provider what it has. `quiet` is for the automatic ask when the
// panel is painted, where a server that is simply not running yet is normal and
// should not read as an error.
async function refreshModels(quiet) {
  const provider = settingsStore.PROVIDERS[selected];
  if (!provider.local) return;
  const asked = selected;

  refreshModelsEl.disabled = true;
  if (!quiet) statusEl.textContent = `Asking ${provider.label}...`;
  try {
    const models = await settingsStore.listModels(draft());
    // The provider may have been switched while the request was in flight.
    if (asked !== selected) return;
    discovered[asked] = models;
    fillModels(modelsFor(provider), storedModel());
    if (models.length) {
      modelHintEl.textContent = `${models.length} model${models.length === 1 ? '' : 's'} found. ${provider.modelHint}`;
      statusEl.textContent = quiet ? '' : `${provider.label} is running`;
    } else {
      modelHintEl.textContent = `${provider.label} is running but has no models yet. ${provider.setupHint}`;
      statusEl.textContent = '';
    }
  } catch (error) {
    if (asked !== selected) return;
    modelHintEl.textContent = error.message;
    statusEl.textContent = quiet ? '' : 'Not reachable';
  } finally {
    if (asked === selected) refreshModelsEl.disabled = false;
  }
}

refreshModelsEl.addEventListener('click', () => refreshModels(false));
testEl.addEventListener('click', () => refreshModels(false));
addressEl.addEventListener('change', () => refreshModels(false));

function load() {
  current = settingsStore.read();
  selected = current.provider;
  // paintProvider fills the model drop-down, so it runs after the stored
  // model is known and before anything reads the boxes back.
  paintProvider();
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
  rememberCurrentProvider();
  settingsStore.write({
    provider: selected,
    keys: current.keys,
    models: current.models,
    baseUrls: current.baseUrls,
    // The single-value fields older builds read are kept in step with the
    // provider in use, so rolling back to one of them still works.
    apiKey: current.keys[selected] || '',
    model: current.models[selected] || '',
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
