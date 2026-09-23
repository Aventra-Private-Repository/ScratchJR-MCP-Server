//
//  attachments.js - turning a dropped file into text the model can read.
//
//  Only three kinds are accepted: Markdown, plain text and PDF. A PDF is not
//  text on disk, so its words are pulled out here rather than sent as bytes -
//  the chat APIs behind this panel take text only.
//
//  Everything is read locally. A file is only ever sent anywhere if the message
//  it is attached to is sent.

const fs = require('fs');
const path = require('path');

const KINDS = {
  '.md': 'Markdown',
  '.markdown': 'Markdown',
  '.txt': 'Text',
  '.pdf': 'PDF'
};

// A story prompt does not need a whole book, and every character costs money on
// the family's own account, so a long document is cut short with a note saying
// so rather than sent whole.
const MAX_CHARS = 20000;
// Read before parsing, so a huge PDF fails politely instead of hanging.
const MAX_BYTES = 12 * 1024 * 1024;
// The copy of pdf.js that pdf-parse defaults to. Named here because the worker
// beside it has to be pointed at by hand, see preparePdfJs.
const PDFJS_VERSION = 'v1.10.100';

function extensionOf(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isSupported(filePath) {
  return Object.prototype.hasOwnProperty.call(KINDS, extensionOf(filePath));
}

function supportedList() {
  return ['md', 'txt', 'pdf'];
}

function kindOf(filePath) {
  return KINDS[extensionOf(filePath)] || 'Unknown';
}

// PDF text comes out with the line breaks of the page rather than of the
// sentence, and often with runs of blank lines between blocks.
function tidy(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readText(filePath) {
  return tidy(fs.readFileSync(filePath, 'utf8'));
}

// pdf-parse ships pdf.js, which behaves as if it were on a web page when it is
// loaded in a renderer: it looks for a worker script and refuses to start
// without one. It reads that setting off a global rather than off the module,
// which is why this is set on window and not on what require returns.
function preparePdfJs() {
  const url = require('url');
  const scope = typeof window === 'undefined' ? global : window;
  if (scope.PDFJS && scope.PDFJS.workerSrc) return;

  const buildDir = path.join(path.dirname(require.resolve('pdf-parse')), 'lib', 'pdf.js', PDFJS_VERSION, 'build');
  scope.PDFJS = scope.PDFJS || {};
  scope.PDFJS.workerSrc = url.format({
    pathname: path.join(buildDir, 'pdf.worker.js'),
    protocol: 'file:',
    slashes: true
  });
}

async function readPdf(filePath) {
  // Required here rather than at the top: nothing should pay for loading the
  // PDF parser until a PDF is actually attached.
  preparePdfJs();
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(fs.readFileSync(filePath), {version: PDFJS_VERSION});
  const text = tidy(parsed.text);
  if (!text) {
    throw new Error('That PDF has no text in it - it is probably a scan. Try a text or Markdown file instead.');
  }
  return text;
}

// Reads one file and returns what the panel shows and what the model is sent.
// Throws with a sentence worth showing if the file cannot be used.
async function read(filePath) {
  const extension = extensionOf(filePath);
  if (!isSupported(filePath)) {
    throw new Error(`${path.basename(filePath)} is not a kind of file the assistant can read. Use .md, .txt or .pdf.`);
  }

  const stats = fs.statSync(filePath);
  if (stats.size > MAX_BYTES) {
    throw new Error(`${path.basename(filePath)} is too big to read (${Math.round(stats.size / 1024 / 1024)}MB).`);
  }

  const full = extension === '.pdf' ? await readPdf(filePath) : await readText(filePath);
  if (!full) throw new Error(`${path.basename(filePath)} is empty.`);

  const truncated = full.length > MAX_CHARS;
  return {
    path: filePath,
    name: path.basename(filePath),
    kind: kindOf(filePath),
    chars: full.length,
    truncated: truncated,
    text: truncated ? full.slice(0, MAX_CHARS) : full
  };
}

// Lays the documents out for the model, ahead of what the child typed, with
// their names kept so the assistant can refer to them by name.
function toPrompt(attachments, message) {
  if (!attachments || !attachments.length) return message;

  const parts = attachments.map(file => {
    const note = file.truncated ? `\n[... only the first ${MAX_CHARS} characters are shown]` : '';
    return `--- start of ${file.name} (${file.kind}) ---\n${file.text}${note}\n--- end of ${file.name} ---`;
  });

  parts.push(
    attachments.length === 1
      ? `The document above was attached to this message. Use what it says.`
      : `The ${attachments.length} documents above were attached to this message. Use what they say.`
  );
  parts.push(message);
  return parts.join('\n\n');
}

module.exports = {read, isSupported, supportedList, kindOf, toPrompt, MAX_CHARS};
