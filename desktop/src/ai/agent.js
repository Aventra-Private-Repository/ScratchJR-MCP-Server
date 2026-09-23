//
//  agent.js - the tool-calling loop behind the assistant panel.
//
//  DeepSeek and OpenRouter both speak the OpenAI chat completions shape, so one
//  client covers both and only the base URL and model differ.
//
//  The loop is deliberately bounded. Each round is a paid request, and a model
//  that misreads a tool error can otherwise retry it indefinitely, so the round
//  budget from Settings is a spending guard as much as a correctness one.
//
//  Replies are streamed. A story can take a minute of tool calls to build, and
//  a panel that shows nothing until the end looks broken, so every token and
//  every thinking step is handed to the panel as it arrives. Electron 1.8 is
//  Chrome 59, which has fetch streams but no AbortController, so a stop is done
//  by cancelling the body reader.

const path = require('path');

const settingsStore = require('./settings');
const log = require(path.join(__dirname, '..', 'log.js'));

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
  'A message may arrive with documents attached, between --- start of ... --- markers. They are notes, stories or plans to build from.',
  'Work from what they say instead of asking for it to be retyped, and say which document an idea came from when it matters.',
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

  cancel() {
    this.cancelled = true;
    // Chrome 59 has no AbortController, so the open response is dropped by
    // cancelling its reader; the loop notices on its next pass either way.
    if (this.reader) { try { this.reader.cancel(); } catch (error) { /* already closed */ } }
  }

  // Streams one assistant reply, handing every delta to `emit` as it lands and
  // returning the finished message in the non-streaming shape the loop expects.
  async complete(settings, emit) {
    const provider = settingsStore.PROVIDERS[settings.provider];
    const body = {
      model: settingsStore.activeModel(settings),
      messages: this.messages,
      tools: this.session.toolDefinitions(),
      tool_choice: 'auto',
      stream: true
    };

    // Asking for the thinking has to be explicit, and each provider spells it
    // differently. Only sent for the models that advertise it, since an unknown
    // field is rejected outright by DeepSeek.
    if (settingsStore.isReasoningModel(settings)) {
      if (settings.provider === 'deepseek') body.thinking = {type: 'enabled'};
      else body.include_reasoning = true;
    }

    log.info('Asking the model', {
      provider: provider.label,
      model: body.model,
      messages: this.messages.length,
      thinking: Boolean(body.thinking || body.include_reasoning)
    });

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey.trim()}`,
        // OpenRouter attributes traffic with these; they are ignored elsewhere.
        'HTTP-Referer': 'https://github.com/SkieAdmin',
        'X-Title': 'Scratch.JR AI-Assisted'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      const failure = describeApiFailure(response.status, text, provider.label);
      log.error('The model refused the request', {status: response.status, reason: failure});
      throw new Error(failure);
    }

    return await this.readStream(response, provider, emit);
  }

  async readStream(response, provider, emit) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const message = {role: 'assistant', content: '', tool_calls: []};
    let reasoning = '';
    let buffer = '';
    let sawAnything = false;

    this.reader = reader;
    try {
      for (;;) {
        if (this.cancelled) { reader.cancel(); break; }
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, {stream: true});

        // SSE frames are separated by a blank line; keep the tail for next time.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();

        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let parsed;
            try { parsed = JSON.parse(data); }
            catch (error) { continue; }   // a keep-alive or a half frame

            if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
            const choice = (parsed.choices || [])[0];
            if (!choice) continue;
            sawAnything = true;
            const delta = choice.delta || {};

            if (delta.reasoning_content || delta.reasoning) {
              const text = delta.reasoning_content || delta.reasoning;
              reasoning += text;
              emit({type: 'reasoning-delta', text: text});
            }
            if (delta.content) {
              message.content += delta.content;
              emit({type: 'assistant-delta', text: delta.content});
            }
            for (const call of delta.tool_calls || []) {
              mergeToolCall(message.tool_calls, call);
            }
          }
        }
      }
    } finally {
      this.reader = null;
    }

    if (!sawAnything && !this.cancelled) {
      throw new Error(`${provider.label} returned no reply. Check that the model name is correct.`);
    }
    log.info('Model replied', {
      characters: message.content.length,
      thinkingCharacters: reasoning.length,
      toolCalls: message.tool_calls.map(call => call.function.name)
    });
    if (reasoning) emit({type: 'reasoning-done'});
    if (message.content) emit({type: 'assistant-done'});
    // With tools in the request, DeepSeek requires every earlier turn's
    // reasoning_content to be sent back with it; leaving it out is a 400 on the
    // next round. It is kept on the message for that reason, not for display.
    if (reasoning) message.reasoning_content = reasoning;
    if (!message.tool_calls.length) delete message.tool_calls;
    return message;
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

      emit({type: 'round', round: round + 1, of: budget});
      // The reply streams straight into the panel, so by the time this resolves
      // the text is already on screen and only the tool calls are left to run.
      const message = await this.complete(settings, emit);
      if (this.cancelled) { emit({type: 'notice', text: 'Stopped.'}); return; }
      this.messages.push(message);

      const calls = message.tool_calls || [];
      if (!calls.length) return;

      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        if (this.cancelled) {
          // Every call in the batch has to be answered, even when it never ran:
          // a request carrying a tool call with no result is rejected outright,
          // which would break the next message rather than this one.
          for (const skipped of calls.slice(index)) {
            this.messages.push({
              role: 'tool',
              tool_call_id: skipped.id,
              content: 'ERROR: stopped before this tool ran.'
            });
          }
          emit({type: 'notice', text: 'Stopped.'});
          return;
        }

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

    log.warn('Stopped at the round limit', {rounds: budget});
    emit({type: 'notice', text: `Stopped after ${budget} rounds of tool calls. Ask again to continue, or raise the limit in Settings.`});
  }
}

// Tool calls arrive in fragments: the first delta carries the id and name, the
// rest extend the JSON arguments a few characters at a time.
function mergeToolCall(calls, fragment) {
  const index = typeof fragment.index === 'number' ? fragment.index : calls.length;
  let call = calls[index];
  if (!call) {
    call = {id: '', type: 'function', function: {name: '', arguments: ''}};
    calls[index] = call;
  }
  if (fragment.id) call.id = fragment.id;
  if (fragment.type) call.type = fragment.type;
  const part = fragment.function || {};
  if (part.name) call.function.name += part.name;
  if (part.arguments) call.function.arguments += part.arguments;
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
