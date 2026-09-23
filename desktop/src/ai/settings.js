//
//  settings.js - where the assistant's provider, key and model are kept.
//
//  Stored as JSON in the Electron userData folder, which is per Windows account
//  and outside the install directory, so an app update never overwrites it.
//
//  The API key is written in plain text. That matches how the editors this
//  replaces (Claude Desktop, Codex) store theirs, but it does mean the file
//  should not be shared. Nothing here is ever written to a log.
//
//  Keys, models and server addresses are held per provider rather than once for
//  all of them. A DeepSeek key is no use to Ollama and deepseek-flash is not a
//  model Ollama has, so one box shared across four providers would mean that
//  switching provider quietly broke the settings of the one left behind.

const fs = require('fs');
const path = require('path');

// Works from both the main process and a renderer with node integration.
const electron = require('electron');
const app = electron.app || (electron.remote && electron.remote.app);

// The model lists are what the Settings window offers in its drop-down. Each
// entry is a real id the provider accepts today; `reasoning` marks the ones
// that think before answering, which the panel shows in its own block.
//
// `local` marks the two that run on this machine. They need no key and no
// account, their model list is whatever has been downloaded rather than
// anything that can be written down here, and their address can be changed
// because the server may be on another port or another computer on the network.
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    modelHint: 'Flash answers quickly and costs less. Pro thinks first, which is slower but better at long stories.',
    models: [
      {id: 'deepseek-flash', label: 'DeepSeek Flash - fast, everyday chat', reasoning: false},
      {id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro - thinks before answering', reasoning: true}
    ]
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '~deepseek/deepseek-flash-latest',
    keyUrl: 'https://openrouter.ai/keys',
    modelHint: 'The "latest" slugs follow DeepSeek as new versions land, so they do not need changing here.',
    models: [
      {id: '~deepseek/deepseek-flash-latest', label: 'DeepSeek Flash (latest) - fast, everyday chat', reasoning: false},
      {id: '~deepseek/deepseek-pro-latest', label: 'DeepSeek Pro (latest) - thinks before answering', reasoning: true},
      {id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash - pinned version', reasoning: false},
      {id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro - pinned version, thinks first', reasoning: true}
    ]
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    local: true,
    defaultModel: '',
    keyUrl: 'https://lmstudio.ai',
    setupHint: 'Open LM Studio, go to the Developer tab and start the local server. Load a model that supports tool use, or the assistant can talk but not build.',
    modelHint: 'The list is what LM Studio has downloaded. Press Refresh after adding a new one.',
    models: []
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    local: true,
    defaultModel: '',
    keyUrl: 'https://ollama.com/search?c=tools',
    setupHint: 'Install Ollama and pull a model that supports tools, such as: ollama pull qwen3:8b. Ollama then serves in the background.',
    modelHint: 'The list is what "ollama list" shows. Only models tagged for tools can drive the editor.',
    models: []
  }
};

const DEFAULTS = {
  provider: 'deepseek',
  // Per provider, keyed by provider id. The bare `apiKey` and `model` below are
  // what older settings files hold; read() folds them into these on first load.
  keys: {},
  models: {},
  baseUrls: {},
  apiKey: '',
  model: '',
  // A confused model can otherwise loop on tool calls and quietly spend money.
  maxRounds: 12,
  // The assistant panel folds away behind the edge tab; remembered per install.
  assistantVisible: true,
  // Width of that panel in pixels, set by dragging its edge.
  assistantWidth: 380,
  // Blank means "work it out"; see resolveServerPath in mcp.js.
  mcpServerPath: '',
  nodePath: ''
};

function provider(settings) {
  return PROVIDERS[settings.provider] || PROVIDERS[DEFAULTS.provider];
}

function isLocal(settings) {
  return Boolean(provider(settings).local);
}

// Where the request actually goes. Only the local providers can be pointed
// somewhere else: a hosted endpoint has one address, and letting that be edited
// is a way to send a paid key to a stranger.
function baseUrl(settings) {
  const chosen = provider(settings);
  if (!chosen.local) return chosen.baseUrl;
  const override = ((settings.baseUrls || {})[settings.provider] || '').trim();
  return normaliseBaseUrl(override) || chosen.baseUrl;
}

// People paste whatever their server printed, which is usually the bare host.
// Accept that, the /v1 form, and a trailing slash, rather than failing on any.
function normaliseBaseUrl(value) {
  let url = (value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  if (!/\/v\d+$/i.test(url)) url += '/v1';
  return url;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'ai-settings.json');
}

function read() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read assistant settings:', error.message);
  }
  const merged = Object.assign({}, DEFAULTS, stored);
  if (!PROVIDERS[merged.provider]) merged.provider = DEFAULTS.provider;
  merged.keys = Object.assign({}, merged.keys);
  merged.models = Object.assign({}, merged.models);
  merged.baseUrls = Object.assign({}, merged.baseUrls);

  // A settings file written before the per-provider maps existed holds one key
  // and one model, belonging to whichever provider was selected at the time.
  // Only such a file is migrated: `apiKey` is still written by write() so that
  // an older build could be rolled back to, and reading it again on a file that
  // already has the maps would file the last provider's key under the current
  // one - which is how a DeepSeek key would end up sent to Ollama.
  const predatesMaps = !stored.keys && !stored.models;
  if (predatesMaps) {
    if (merged.apiKey) merged.keys[merged.provider] = merged.apiKey;
    if (merged.model) merged.models[merged.provider] = merged.model;
  }
  return merged;
}

// Electron 1.8 runs Node 8, where mkdirSync has no recursive option: passing
// one is read as a mode, so an existing folder throws EEXIST and every save
// fails. Create a level at a time instead.
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      ensureDir(path.dirname(dir));
      fs.mkdirSync(dir);
    } else if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

function write(values) {
  const current = read();
  // A copy, not current itself: the maps below are merged against what was
  // stored, and assigning onto current would have overwritten that first.
  const next = Object.assign({}, current, values);
  // The maps merge a field at a time. A save carries only the provider being
  // edited, and must not wipe what the other three had.
  for (const field of ['keys', 'models', 'baseUrls']) {
    if (values[field]) next[field] = Object.assign({}, current[field], values[field]);
  }
  // Named, not valued: the key must never reach the log.
  try {
    require(path.join(__dirname, '..', 'log.js')).info('Settings written', {fields: Object.keys(values)});
  } catch (error) { /* the log is never worth failing a save for */ }
  const file = settingsFile();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// The model box may be left empty, in which case the provider's default stands
// in. The local providers have no default: there is no model until one has been
// downloaded, and a guessed name would only produce a 404 with no explanation.
// Both read only the per-provider maps. read() has already folded an older
// file's single key and model into the slot of the provider they belonged to,
// and falling back to those bare fields here instead would hand the provider in
// use whatever the last provider left behind - a DeepSeek key sent to
// OpenRouter, or a DeepSeek model name asked of Ollama.
function activeModel(settings) {
  const chosen = ((settings.models || {})[settings.provider] || '').trim();
  return chosen || provider(settings).defaultModel;
}

function apiKey(settings) {
  return ((settings.keys || {})[settings.provider] || '').trim();
}

// True when the chosen model is one of the thinking models above. The agent
// asks DeepSeek for that thinking explicitly, since a model that can think
// does not always do so by default. A local model is never asked: it either
// thinks inside <think> tags in the ordinary reply, which agent.js pulls back
// out, or it does not think at all, and the flag is rejected either way.
function isReasoningModel(settings) {
  if (isLocal(settings)) return false;
  const chosen = activeModel(settings);
  const known = (provider(settings).models || []).find(model => model.id === chosen);
  return known ? Boolean(known.reasoning) : /(-pro|pro-latest|reasoner)$/.test(chosen);
}

// A hosted provider needs a key. A local one needs a model instead, since there
// is nothing sensible to fall back on and a blank model name is a puzzling 404.
function isConfigured(settings) {
  if (isLocal(settings)) return Boolean(activeModel(settings));
  return Boolean(apiKey(settings));
}

// What to tell someone who has not finished setting up, in the terms of the
// provider they actually picked.
function setupMessage(settings) {
  const chosen = provider(settings);
  if (chosen.local) {
    return `No ${chosen.label} model chosen yet. Start ${chosen.label}, then open File > Settings and pick a model.`;
  }
  return `No API key yet. Open File > Settings and paste a ${chosen.label} key.`;
}

// Asks a provider what models it has, for the two local ones where the list is
// whatever has been downloaded and so cannot be written down in advance. Both
// answer the OpenAI /models shape; Ollama lists there as well as on its own
// /api/tags, so one request covers the pair.
async function listModels(settings) {
  const url = `${baseUrl(settings)}/models`;
  const headers = {};
  const key = apiKey(settings);
  if (key) headers['Authorization'] = `Bearer ${key}`;

  let response;
  try {
    response = await fetch(url, {headers: headers});
  } catch (error) {
    // Only the Settings window asks for models, and telling someone already
    // looking at the address box to go and find it reads as a dead end.
    throw new Error(unreachableMessage(settings, {inSettings: true}));
  }
  if (!response.ok) {
    throw new Error(`${provider(settings).label} answered ${response.status} when asked for its models.`);
  }
  const payload = await response.json();
  const rows = payload.data || payload.models || [];
  const ids = rows.map(row => row.id || row.name).filter(Boolean);
  // Ollama can list the same model twice, once under a digest.
  return ids.filter((id, index) => ids.indexOf(id) === index).sort();
}

// A local server that is not running fails as a dropped connection rather than
// an HTTP status, so there is no body to quote and the advice has to come from
// here instead.
function unreachableMessage(settings, options) {
  const chosen = provider(settings);
  const where = `${chosen.label} at ${baseUrl(settings)}`;
  if (!chosen.local) return `Could not reach ${where}. Check this computer's internet connection.`;
  const advice = (options && options.inSettings)
    ? ''
    : ' If the server is on another port or machine, set its address in File > Settings.';
  return `Could not reach ${where}. ${chosen.setupHint}${advice}`;
}

module.exports = {
  PROVIDERS, DEFAULTS, read, write,
  activeModel, apiKey, baseUrl, normaliseBaseUrl, isLocal, isReasoningModel, isConfigured,
  setupMessage, unreachableMessage, listModels, settingsFile
};
