//
//  settings.js - where the assistant's provider, key and model are kept.
//
//  Stored as JSON in the Electron userData folder, which is per Windows account
//  and outside the install directory, so an app update never overwrites it.
//
//  The API key is written in plain text. That matches how the editors this
//  replaces (Claude Desktop, Codex) store theirs, but it does mean the file
//  should not be shared. Nothing here is ever written to a log.

const fs = require('fs');
const path = require('path');

// Works from both the main process and a renderer with node integration.
const electron = require('electron');
const app = electron.app || (electron.remote && electron.remote.app);

// The model lists are what the Settings window offers in its drop-down. Each
// entry is a real id the provider accepts today; `reasoning` marks the ones
// that think before answering, which the panel shows in its own block.
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
  }
};

// True when the chosen model is one of the thinking models above. The agent
// asks DeepSeek for that thinking explicitly, since a model that can think
// does not always do so by default.
function isReasoningModel(settings) {
  const chosen = activeModel(settings);
  const known = (PROVIDERS[settings.provider].models || []).find(model => model.id === chosen);
  return known ? Boolean(known.reasoning) : /(-pro|pro-latest|reasoner)$/.test(chosen);
}

const DEFAULTS = {
  provider: 'deepseek',
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
  const next = Object.assign(read(), values);
  // Named, not valued: the key must never reach the log.
  try {
    require(path.join(__dirname, '..', 'log.js')).info('Settings written', {fields: Object.keys(values)});
  } catch (error) { /* the log is never worth failing a save for */ }
  const file = settingsFile();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// The model box may be left empty, in which case the provider's default stands in.
function activeModel(settings) {
  const chosen = (settings.model || '').trim();
  return chosen || PROVIDERS[settings.provider].defaultModel;
}

function isConfigured(settings) {
  return Boolean((settings.apiKey || '').trim());
}

module.exports = {PROVIDERS, DEFAULTS, read, write, activeModel, isReasoningModel, isConfigured, settingsFile};
