//
//  node-runtime.js - finds a usable Node.js, and fetches one if there is none.
//
//  The assistant runs the ScratchJr tool server with Node 22 or newer, which
//  this app does not ship. Rather than sending a parent off to nodejs.org, a
//  missing or too-old Node is downloaded here.
//
//  The portable zip is used rather than the installer: it extracts into the
//  app's own userData folder, needs no administrator rights and no UAC prompt,
//  changes nothing about the machine's PATH, and leaves any Node the family
//  already had exactly as it was. Uninstalling the app takes it with it.

const {spawnSync, execFile} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron');
const app = electron.app || (electron.remote && electron.remote.app);

const log = require(path.join(__dirname, '..', 'log.js'));

const MINIMUM_MAJOR = 22;
// Used only if the version index cannot be reached.
const FALLBACK_VERSION = 'v22.20.0';

function managedRoot() {
  return path.join(app.getPath('userData'), 'node-runtime');
}

// Asking the binary itself is the only honest check: a node.exe on PATH may be
// any age, and a path in Settings may point at something that no longer exists.
function inspect(nodePath) {
  if (!nodePath) return null;
  let result;
  try {
    result = spawnSync(nodePath, ['-v'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  } catch (error) {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  const version = (result.stdout || '').trim();
  const major = Number((version.match(/^v(\d+)\./) || [])[1]);
  if (!major) return null;
  return {path: nodePath, version: version, major: major, ok: major >= MINIMUM_MAJOR};
}

// Any node.exe previously extracted into userData, whatever its version folder.
function managedNode() {
  const root = managedRoot();
  let entries;
  try { entries = fs.readdirSync(root); } catch (error) { return null; }
  for (const entry of entries) {
    const candidate = path.join(root, entry, process.platform === 'win32' ? 'node.exe' : 'bin/node');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Returns {path, version, major, ok} for the best Node available without
// downloading, or null when there is none. Explicit setting wins, then a
// managed copy, then whatever is on PATH.
function findNode(settings) {
  const candidates = [];
  if (settings && settings.nodePath) candidates.push(settings.nodePath);
  const managed = managedNode();
  if (managed) candidates.push(managed);
  candidates.push(process.platform === 'win32' ? 'node.exe' : 'node');

  let best = null;
  for (const candidate of candidates) {
    const found = inspect(candidate);
    if (!found) continue;
    if (found.ok) return found;
    if (!best) best = found;          // too old, but worth naming in a message
  }
  return best;
}

async function latestVersion() {
  try {
    const response = await fetch('https://nodejs.org/dist/index.json');
    if (!response.ok) throw new Error(String(response.status));
    const releases = await response.json();
    const usable = releases.filter(release => {
      const major = Number((release.version.match(/^v(\d+)\./) || [])[1]);
      return major >= MINIMUM_MAJOR && release.lts;
    });
    if (usable.length) return usable[0].version;
  } catch (error) {
    // The pinned version below is a known-good release; a machine that cannot
    // reach the index usually cannot reach the download either, and the caller
    // reports that failure properly.
  }
  return FALLBACK_VERSION;
}

function extractZip(zipFile, destination) {
  return new Promise((resolve, reject) => {
    // Expand-Archive ships with Windows PowerShell 5, which is present on every
    // Windows 10 and 11 machine. It avoids adding an unzip dependency.
    const command = `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {windowsHide: true, maxBuffer: 1024 * 1024}, error => error ? reject(error) : resolve());
  });
}

// Downloads and unpacks Node into userData. onProgress(text) is called with
// short status lines so the chat panel can show what is happening.
async function installNode(onProgress) {
  const report = onProgress || function () {};
  if (process.platform !== 'win32') {
    throw new Error('Automatic Node.js installation is only wired up for Windows. Install Node 22 or newer and set its path in Settings.');
  }

  const version = await latestVersion();
  const name = `node-${version}-win-${process.arch === 'ia32' ? 'x86' : 'x64'}`;
  const url = `https://nodejs.org/dist/${version}/${name}.zip`;

  log.info('Downloading Node.js', {version: version, url: url});
  report(`Downloading Node.js ${version}. This happens once, and only because no suitable Node was found.`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download Node.js from nodejs.org (${response.status}). Check the internet connection, or install Node 22 yourself and set its path in Settings.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  const zipFile = path.join(os.tmpdir(), `${name}-${Date.now()}.zip`);
  fs.writeFileSync(zipFile, bytes);

  report(`Unpacking ${Math.round(bytes.length / 1024 / 1024)} MB...`);
  const root = managedRoot();
  // Electron 1.8 runs Node 8, where mkdirSync has no recursive option: passing
  // one is read as a mode and an existing folder throws.
  try { fs.mkdirSync(root); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    await extractZip(zipFile, root);
  } finally {
    try { fs.unlinkSync(zipFile); } catch (error) { /* a temp file; leave it to the OS */ }
  }

  const installed = path.join(root, name, 'node.exe');
  if (!fs.existsSync(installed)) {
    throw new Error('Node.js was downloaded but node.exe was not where it was expected. Install Node 22 yourself and set its path in Settings.');
  }

  const found = inspect(installed);
  if (!found || !found.ok) {
    throw new Error('The downloaded Node.js did not run. Install Node 22 yourself and set its path in Settings.');
  }
  log.info('Node.js installed for this app', {version: found.version, path: found.path});
  report(`Node.js ${found.version} is ready.`);
  return found;
}

// The entry point the chat panel uses: return a usable Node, downloading one if
// that is the only way. Never touches a Node that is already good enough.
//
// `confirm` is asked before anything is downloaded, so the decision to install
// belongs to whoever is at the keyboard rather than to the app. It is given
// whatever Node was found, or null when there is none, and answers true or
// false. Leaving it out keeps the old behaviour of installing straight away.
async function ensureNode(settings, onProgress, confirm) {
  const existing = findNode(settings);
  if (existing && existing.ok) {
    log.info('Using Node.js', {version: existing.version, path: existing.path});
    return existing;
  }

  log.warn('No usable Node.js found', existing ? {found: existing.version, needs: MINIMUM_MAJOR} : {needs: MINIMUM_MAJOR});

  if (typeof confirm === 'function') {
    const agreed = await confirm(existing);
    log.info('Node.js install prompt answered', {install: Boolean(agreed)});
    if (!agreed) {
      const error = new Error(existing
        ? `Node ${existing.version} is too old for the ScratchJr tools, which need ${MINIMUM_MAJOR} or newer. Nothing was installed. Say so again when you want the newer copy, or set a path in File > Settings.`
        : `The assistant needs Node.js ${MINIMUM_MAJOR} or newer to run its tools, and nothing was installed. Ask again when you want it, or install Node yourself and set its path in File > Settings.`);
      error.declined = true;
      throw error;
    }
  } else if (existing) {
    (onProgress || function () {})(`Node ${existing.version} is too old for the ScratchJr tools, which need ${MINIMUM_MAJOR} or newer. Fetching a newer copy for this app only; the one already installed is left alone.`);
  }

  try {
    return await installNode(onProgress);
  } catch (error) {
    log.error('Node.js install failed', error);
    throw error;
  }
}

module.exports = {ensureNode, findNode, installNode, inspect, managedRoot, MINIMUM_MAJOR};
