//
//  agent.js - the tool-calling loop behind the assistant panel.
//
//  DeepSeek and OpenRouter both speak the OpenAI chat completions shape, so one
//  client covers both and only the base URL and model differ.
//
//  The loop is deliberately bounded. Each round is a paid request, and a model
//  that misreads a tool error can otherwise retry it indefinitely, so the round
//  budget from Settings is a spending guard as much as a correctness one.

const settingsStore = require('./settings');

const SYSTEM_PROMPT = [
  'You are the built-in assistant of Scratch.JR, a programming app for young children.',
  'You control the real editor beside you through the scratchjr_ tools. Use them; never just describe what the child should click.',
  '',
  'How to work:',
  '- Call scratchjr_connect first in a conversation.',
  '- Call scratchjr_list_assets and scratchjr_block_reference before building, so you use real asset names and supported blocks.',
  '- Build a whole project in one scratchjr_create_project call rather than many small edits.',
  '- To change existing work, call scratchjr_get_project first and pass its revision to scratchjr_edit_project.',
  '- After building, run the project and take a screenshot to check it, then stop with reset and save.',
  '',
  'Limits of ScratchJr, which you must respect and explain rather than work around:',
  '- Four pages per project maximum. More scenes than that need a second project.',
  '- No variables, scores, keyboard input or arithmetic. Use clicks, collisions, colour messages and page changes.',
  '- Text x and y is the centre of the text, so titles read best at x 240.',
  '',
  'Talk to the child, or the adult helping them, in short plain sentences. No jargon, no block-by-block recitals.',
  'If a tool returns an error, say what failed and what you are trying instead. Never claim something worked when the tool reported an error.'
].join('\n');

// A tool result can be large; the model rarely needs every byte of a project dump.
const MAX_RESULT_CHARS = 6000;

function trimResult(text) {
  if (!text) return '(no output)';
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + `\n... truncated, ${text.length - MAX_RESULT_CHARS} more characters`;
}

class Agent {
  constructor(session) {
    this.session = session;
    this.messages = [{role: 'system', content: SYSTEM_PROMPT}];
    this.cancelled = false;
  }

  reset() {
    this.messages = [{role: 'system', content: SYSTEM_PROMPT}];
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async complete(settings) {
    const provider = settingsStore.PROVIDERS[settings.provider];
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey.trim()}`,
        // OpenRouter attributes traffic with these; they are ignored elsewhere.
        'HTTP-Referer': 'https://github.com/SkieAdmin',
        'X-Title': 'Scratch.JR AI-Assisted'
      },
      body: JSON.stringify({
        model: settingsStore.activeModel(settings),
        messages: this.messages,
        tools: this.session.toolDefinitions(),
        tool_choice: 'auto'
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(describeApiFailure(response.status, body, provider.label));
    }

    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    const choice = (payload.choices || [])[0];
    if (!choice) throw new Error(`${provider.label} returned no reply. Check that the model name is correct.`);
    return choice.message;
  }

  // Drives one user turn to completion, reporting progress through `emit`.
  // emit(event) where event is {type:'assistant'|'tool'|'tool-result'|'notice', ...}
  async run(userText, emit) {
    const settings = settingsStore.read();
    if (!settingsStore.isConfigured(settings)) {
      throw new Error('No API key yet. Open File > Settings and paste a DeepSeek or OpenRouter key.');
    }

    this.cancelled = false;
    this.messages.push({role: 'user', content: userText});

    const budget = Math.max(1, Number(settings.maxRounds) || 12);
    for (let round = 0; round < budget; round++) {
      if (this.cancelled) { emit({type: 'notice', text: 'Stopped.'}); return; }

      const message = await this.complete(settings);
      this.messages.push(message);

      const calls = message.tool_calls || [];
      if (message.content) emit({type: 'assistant', text: message.content});
      if (!calls.length) return;

      for (const call of calls) {
        if (this.cancelled) { emit({type: 'notice', text: 'Stopped.'}); return; }

        let args = {};
        let argError = null;
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
        catch (error) { argError = `Arguments were not valid JSON: ${error.message}`; }

        emit({type: 'tool', id: call.id, name: call.function.name, args: args});

        const result = argError
          ? {text: argError, images: [], isError: true}
          : await this.session.call(call.function.name, args);

        emit({type: 'tool-result', id: call.id, name: call.function.name, text: result.text, images: result.images, isError: result.isError});

        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: trimResult(result.isError ? `ERROR: ${result.text}` : result.text)
        });

        // An image cannot ride along in a tool message, so describe it instead.
        if (result.images.length) {
          this.messages.push({role: 'user', content: `(A screenshot was captured and shown to the child. Continue without describing pixel detail you cannot see.)`});
        }
      }
    }

    emit({type: 'notice', text: `Stopped after ${budget} rounds of tool calls. Ask again to continue, or raise the limit in Settings.`});
  }
}

function describeApiFailure(status, body, providerLabel) {
  let detail = (body || '').trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed.error && parsed.error.message) detail = parsed.error.message;
  } catch (error) { /* keep the raw body */ }
  if (detail.length > 300) detail = detail.slice(0, 300) + '...';

  if (status === 401 || status === 403) return `${providerLabel} rejected the API key. Check it in File > Settings. ${detail}`;
  if (status === 402) return `${providerLabel} says the account is out of credit. ${detail}`;
  if (status === 404) return `${providerLabel} does not know that model name. Check it in File > Settings. ${detail}`;
  if (status === 429) return `${providerLabel} is rate limiting this key. Wait a moment and try again. ${detail}`;
  return `${providerLabel} returned an error (${status}). ${detail}`;
}

module.exports = {Agent, SYSTEM_PROMPT};
