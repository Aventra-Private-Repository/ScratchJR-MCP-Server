//
//  agent.js - the tool-calling loop behind the assistant panel.
//
//  DeepSeek, OpenRouter, LM Studio and Ollama all speak the OpenAI chat
//  completions shape, so one client covers all four and only the base URL, the
//  model and the key differ. The two local ones need no key at all, and they
//  report their thinking inside the reply rather than in a field of its own,
//  which is the one place the code has to tell them apart.
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
    const local = settingsStore.isLocal(settings);
    const endpoint = settingsStore.baseUrl(settings);
    const body = {
      model: settingsStore.activeModel(settings),
      messages: this.messages,
      tools: this.session.toolDefinitions(),
      tool_choice: 'auto',
      stream: true
    };

    // Asking for the thinking has to be explicit, and each provider spells it
    // differently. Only sent for the models that advertise it, since an unknown
    // field is rejected outright by DeepSeek. Never sent to a local server:
    // isReasoningModel is false there, and the thinking is recovered from the
    // <think> tags in the reply instead.
    if (settingsStore.isReasoningModel(settings)) {
      if (settings.provider === 'deepseek') body.thinking = {type: 'enabled'};
      else body.include_reasoning = true;
    }

    log.info('Asking the model', {
      provider: provider.label,
      endpoint: endpoint,
      model: body.model,
      messages: this.messages.length,
      thinking: Boolean(body.thinking || body.include_reasoning)
    });

    const headers = {
      'Content-Type': 'application/json',
      // OpenRouter attributes traffic with these; they are ignored elsewhere.
      'HTTP-Referer': 'https://github.com/SkieAdmin',
      'X-Title': 'Scratch.JR AI-Assisted'
    };
    // LM Studio and Ollama want no key. Sending an empty bearer is worse than
    // sending none, since a proxy in front of either reads it as a bad key
    // rather than as no key at all.
    const key = settingsStore.apiKey(settings);
    if (key) headers['Authorization'] = `Bearer ${key}`;

    let response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (error) {
      // A server that is not running drops the connection, so there is no
      // status and no body to explain it with.
      const failure = settingsStore.unreachableMessage(settings);
      log.error('Could not reach the model', {endpoint: endpoint, reason: error.message});
      throw new Error(failure);
    }

    if (!response.ok) {
      const text = await response.text();
      const failure = describeApiFailure(response.status, text, provider.label, local);
      log.error('The model refused the request', {status: response.status, reason: failure});
      throw new Error(failure);
    }

    return await this.readStream(response, provider, emit, local);
  }

  async readStream(response, provider, emit, local) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const message = {role: 'assistant', content: '', tool_calls: []};
    let reasoning = '';
    let buffer = '';
    let sawAnything = false;
    // Only a local model hides its thinking in the reply text; a hosted one
    // sends it in a field, and running the splitter there would eat a <think>
    // that a child actually asked to have written on screen.
    const think = local ? createThinkSplitter() : null;

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
              const split = think ? think.push(delta.content) : {thinking: '', content: delta.content};
              if (split.thinking) {
                reasoning += split.thinking;
                emit({type: 'reasoning-delta', text: split.thinking});
              }
              if (split.content) {
                message.content += split.content;
                emit({type: 'assistant-delta', text: split.content});
              }
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

    // A tag held back for the next chunk that never came is ordinary text.
    if (think) {
      const rest = think.flush();
      if (rest.thinking) { reasoning += rest.thinking; emit({type: 'reasoning-delta', text: rest.thinking}); }
      if (rest.content) { message.content += rest.content; emit({type: 'assistant-delta', text: rest.content}); }
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
    // A local model is the other way round: its thinking was stripped out of
    // the content above and is not sent back, which is what those models are
    // trained to expect and keeps the context from filling with old thinking.
    if (reasoning && !local) message.reasoning_content = reasoning;
    if (!message.tool_calls.length) delete message.tool_calls;
    return message;
  }

  // Drives one user turn to completion, reporting progress through `emit`.
  // emit(event) where event is {type:'assistant'|'tool'|'tool-result'|'notice', ...}
  async run(userText, emit) {
    const settings = settingsStore.read();
    if (!settingsStore.isConfigured(settings)) {
      throw new Error(settingsStore.setupMessage(settings));
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

function describeApiFailure(status, body, providerLabel, local) {
  let detail = (body || '').trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed.error && parsed.error.message) detail = parsed.error.message;
    else if (typeof parsed.error === 'string') detail = parsed.error;
  } catch (error) { /* keep the raw body */ }
  if (detail.length > 300) detail = detail.slice(0, 300) + '...';

  if (status === 401 || status === 403) return `${providerLabel} rejected the API key. Check it in File > Settings. ${detail}`;
  if (status === 402) return `${providerLabel} says the account is out of credit. ${detail}`;
  if (status === 404) {
    // On a local server this nearly always means the model is not downloaded
    // rather than misspelt, and saying so saves a round of guessing.
    if (local) return `${providerLabel} has no such model loaded. Download it first, then press Refresh in File > Settings. ${detail}`;
    return `${providerLabel} does not know that model name. Check it in File > Settings. ${detail}`;
  }
  if (status === 429) return `${providerLabel} is rate limiting this key. Wait a moment and try again. ${detail}`;
  // A local model too small for the request runs out of context rather than
  // money, and the fix is a different model or a shorter chat, not a top-up.
  if (local && status === 400 && /context|token/i.test(detail)) {
    return `${providerLabel} ran out of room for the conversation. Start a new chat, or pick a model with a larger context. ${detail}`;
  }
  return `${providerLabel} returned an error (${status}). ${detail}`;
}

// Local models with a thinking mode wrap it in <think> tags inside the ordinary
// content stream instead of sending it in a field, so it has to be pulled back
// out for the panel to show it in its own folded block. A tag can straddle two
// deltas, so any tail that could be the start of one is held back until the
// next chunk settles it.
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function createThinkSplitter() {
  let buffer = '';
  let inside = false;

  function take(out, text) {
    if (inside) out.thinking += text; else out.content += text;
  }

  return {
    push(text) {
      buffer += text;
      const out = {thinking: '', content: ''};
      for (;;) {
        const tag = inside ? THINK_CLOSE : THINK_OPEN;
        const at = buffer.indexOf(tag);
        if (at !== -1) {
          take(out, buffer.slice(0, at));
          buffer = buffer.slice(at + tag.length);
          inside = !inside;
          continue;
        }
        // No whole tag left. Release everything that cannot be the start of one.
        const held = partialTagLength(buffer, tag);
        take(out, buffer.slice(0, buffer.length - held));
        buffer = buffer.slice(buffer.length - held);
        return out;
      }
    },
    // Whatever was being held back when the stream ended is just text.
    flush() {
      const out = {thinking: '', content: ''};
      take(out, buffer);
      buffer = '';
      return out;
    }
  };
}

// How many of the trailing characters of `text` could begin `tag`.
function partialTagLength(text, tag) {
  const most = Math.min(tag.length - 1, text.length);
  for (let length = most; length > 0; length--) {
    if (text.slice(text.length - length) === tag.slice(0, length)) return length;
  }
  return 0;
}

module.exports = {Agent, SYSTEM_PROMPT};
