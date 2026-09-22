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

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    modelHint: 'deepseek-chat is the general model; deepseek-reasoner thinks longer and costs more.'
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    keyUrl: 'https://openrouter.ai/keys',
    modelHint: 'Use the full slug, for example deepseek/deepseek-chat or openai/gpt-4o-mini.'
  }
};

const DEFAULTS = {
  provider: 'deepseek',
  apiKey: '',
  model: '',
  // A confused model can otherwise loop on tool calls and quietly spend money.
  maxRounds: 12,
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

function write(values) {
  const next = Object.assign(read(), values);
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
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

module.exports = {PROVIDERS, DEFAULTS, read, write, activeModel, isConfigured, settingsFile};
