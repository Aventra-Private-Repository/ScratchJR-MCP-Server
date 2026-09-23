//
//  log.js - the app's own log file.
//
//  One file per day in a Logs folder beside the executable, so a parent can
//  find it without knowing where Windows hides application data. If that folder
//  cannot be written - an install under Program Files, a locked-down machine -
//  it falls back to the app's userData folder rather than failing, because the
//  app must run with or without administrator rights.
//
//  Lines look like:
//    [ 9-23-2026 08:41:07 ] [ INFO ] - Assistant panel opened
//
//  Nothing secret is written. API keys are replaced before a line is stored,
//  including inside anything a caller passes as detail.

const fs = require('fs');
const path = require('path');

const electron = require('electron');
const app = electron.app || (electron.remote && electron.remote.app);

const LEVELS = {INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR'};
// Old logs are worth keeping for a bug report, but not forever.
const KEEP_DAYS = 30;

let logDirectory = null;
let warnedAboutDirectory = false;

function twoDigits(value) {
  return value < 10 ? '0' + value : String(value);
}

// 9-23-2026, the way the file name is asked for: no padding on the date parts.
function dateStamp(when) {
  return `${when.getMonth() + 1}-${when.getDate()}-${when.getFullYear()}`;
}

function timeStamp(when) {
  return `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}:${twoDigits(when.getSeconds())}`;
}

function canWriteTo(directory) {
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') return false;
  }
  try {
    const probe = path.join(directory, '.write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (error) {
    return false;
  }
}

// An installed build lives in <install root>/app-<version>/, and that folder is
// replaced on every update. The logs belong beside the shortcut instead, in the
// install root, so they survive an update and sit where someone would look.
function appFolder() {
  const executable = path.dirname(app.getPath('exe'));
  return /^app-\d/.test(path.basename(executable)) ? path.dirname(executable) : executable;
}

// Beside the app first, which is what someone looking for their logs will
// check; the app's own data folder only if that is not writable.
function resolveDirectory() {
  if (logDirectory) return logDirectory;

  const candidates = [];
  try { candidates.push(path.join(appFolder(), 'Logs')); } catch (error) { /* no app yet */ }
  try { candidates.push(path.join(app.getPath('userData'), 'Logs')); } catch (error) { /* no app yet */ }

  for (const candidate of candidates) {
    if (canWriteTo(candidate)) {
      logDirectory = candidate;
      return logDirectory;
    }
  }
  return null;
}

function currentFile() {
  const directory = resolveDirectory();
  if (!directory) return null;
  return path.join(directory, `${dateStamp(new Date())}_Log.txt`);
}

// An API key must never reach the file, however it was handed in.
function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/("?apiKey"?\s*[:=]\s*"?)[^",}\s]+/gi, '$1***');
}

function describe(detail) {
  if (detail === undefined || detail === null) return '';
  if (detail instanceof Error) return ' ' + (detail.stack || detail.message);
  if (typeof detail === 'string') return ' ' + detail;
  try {
    return ' ' + JSON.stringify(detail);
  } catch (error) {
    return ' [detail could not be read]';
  }
}

function write(level, message, detail) {
  const when = new Date();
  const line = `[ ${dateStamp(when)} ${timeStamp(when)} ] [ ${level} ] - ${redact(message + describe(detail))}\n`;

  const file = currentFile();
  if (!file) {
    if (!warnedAboutDirectory) {
      warnedAboutDirectory = true;
      console.warn('No writable folder for logs; logging to the console only.');
    }
    console.log(line.trim());
    return;
  }

  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (error) {
    console.log(line.trim());
  }
}

function prune() {
  const directory = resolveDirectory();
  if (!directory) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try { entries = fs.readdirSync(directory); } catch (error) { return; }
  for (const entry of entries) {
    if (!/_Log\.txt$/.test(entry)) continue;
    const full = path.join(directory, entry);
    try {
      if (fs.statSync(full).mtime.getTime() < cutoff) fs.unlinkSync(full);
    } catch (error) { /* leave it be */ }
  }
}

module.exports = {
  info: (message, detail) => write(LEVELS.INFO, message, detail),
  warn: (message, detail) => write(LEVELS.WARN, message, detail),
  error: (message, detail) => write(LEVELS.ERROR, message, detail),
  directory: resolveDirectory,
  file: currentFile,
  prune: prune
};
