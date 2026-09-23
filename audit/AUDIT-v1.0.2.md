# Scratch.JR AI-Assisted v1.0.2 audit

Reviewed 2026-09-23. Scope: current working tree, including uncommitted AI/attachment/UI changes; Electron integration, root MCP server, and generated `desktop/mcp` copy. No application code was changed. No paid API calls, real project edits, or installer deployment were performed.

Recommendation: address the high-priority findings before release. Existing tests pass but do not cover the assistant lifecycle or mixed built-in/external client operation.

## Findings

### 1. High — Always-on debugger exposes unrestricted renderer execution

**Locations:** `desktop/src/main.js:54`, `desktop/src/branding.js:35`, `desktop/src/shell/shell.html:11`, `desktop/package.json:144`.

Every normal launch enables the unauthenticated Chrome debugging listener on port 9223. The editor explicitly has Node integration; the bridge itself demonstrates that `Runtime.evaluate` can call `require`. A local client can bypass every MCP schema and revision check and execute arbitrary JavaScript with the application's OS permissions. Closing the assistant panel does not close this listener. The runtime is Electron 1.8.2-beta.3 with embedded Node 8.2.1, independently confirmed by launching its Node mode.

**Scope of claim:** source-confirmed local control surface, not a demonstrated Internet attack or privilege escalation. Loopback binding restricts network reachability but does not authenticate local clients. No cross-origin browser exploit was attempted.

**Fix:** replace the public CDP listener with a narrow authenticated IPC bridge. Make external control explicitly enabled and authenticated, and keep it off when unused. Upgrade Electron and move privileged operations out of renderers into validated main-process handlers. Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) recommends current runtimes, isolation, restricted navigation, and disabling Node integration for untrusted content.

### 2. High — Reasoning models lose required state after their first reply

**Location:** `desktop/src/ai/agent.js:147` through the return from `readStream`.

Streamed `reasoning_content` is accumulated only in a local variable and emitted to the UI. The returned assistant message never receives it. `run()` stores that incomplete message and `complete()` sends it back with `tools` on the next request. This violates DeepSeek's [documented thinking/tool-call contract](https://api-docs.deepseek.com/guides/thinking_mode/) and can cause subsequent requests to be rejected, preventing multi-step project creation with the advertised thinking model.

**Validation:** a synthetic SSE response containing reasoning and one tool call returns a message with the tool call but no `reasoning_content`. No paid provider request was made.

**Fix:** preserve provider-required reasoning fields in assistant history independently of UI rendering, including on subsequent user turns. Preserve OpenRouter's applicable reasoning metadata as well. Add a multi-round provider-contract test.

### 3. High — Built-in and external MCP clients do not share their lock

**Locations:** `src/config.js:30`, `src/service.js:11`, `desktop/src/ai/mcp.js:29`.

The lock is stored in `config.backupDir`, which defaults to a path under the server's installation root. The built-in client chooses `desktop/mcp/src/server.js`; externally registered clients use the repository server. Both target port 9223, but their default locks are `desktop/mcp/backups/scratchjr.lock` and `backups/scratchjr.lock`. Installed copies create further distinct paths.

**Validation:** the offline probe acquires both locks simultaneously. Thus the advertised serialization across clients is absent in the documented mixed-client configuration. Concurrent navigation/writes can interfere; two edits can both pass the revision check before either writes. Actual project loss was not induced.

**Fix:** derive a shared lock identity from the controlled app/database, in a stable per-user location independent of server checkout, version, or backup destination. Prefer serialization inside the app. Recheck revisions at the point of mutation and account for edits made through the UI.

### 4. High — Backups can target a different database from the live editor

**Locations:** `src/config.js:29`, `src/service.js:64`, `desktop/src/main.js:694`, `desktop/src/ai/mcp.js:58`.

The app uses Electron's resolved Documents directory, while the MCP process assumes `homedir()/Documents`. The built-in MCP launcher does not pass the app's actual database path. These diverge for redirected/OneDrive Documents and when `SCRATCHJR_DOCUMENTS` is used. `backup()` flushes the live app and then copies the independently guessed database.

If the guessed file is absent, create/edit/add-asset fail before writing. If an older database exists there, the tool reports a successful backup of the wrong projects and proceeds to modify the real database without the intended recovery copy.

**Validation:** traced both independent path calculations and the child environment. Not reproduced against the user's Documents or a live project.

**Fix:** have the app expose its resolved database identity through the authenticated bridge and use it for backup and locking. At minimum, pass the actual path as `SCRATCHJR_DATABASE` when starting the built-in server, and verify external clients target the same database.

### 5. Medium — Stop leaves unanswered tool calls in conversation history

**Locations:** `desktop/src/ai/agent.js:195`, `desktop/src/ai/agent.js:200`.

The entire assistant tool-call batch is appended before execution. If Stop is pressed during the first tool in a multi-tool reply, its result is appended, then the loop returns before producing results for the remaining calls. The next Send appends a new user message to this incomplete history. APIs requiring matching tool results can reject it; the UI offers no automatic repair.

**Validation:** a mocked two-call batch cancels during the first call. Retained history contains calls `a` and `b`, but only result `a`.

**Fix:** append explicit cancelled results for unexecuted calls, or roll back the incomplete history safely while retaining records of actions already performed. Test Stop followed by Send.

### 6. Medium — Stop cannot interrupt a request waiting for response headers

**Locations:** `desktop/src/ai/agent.js:63`, `desktop/src/ai/agent.js:90`, `desktop/src/shell/shell.js:578`.

Cancellation only cancels `this.reader`, assigned after `fetch()` returns. There is no request deadline. If the provider accepts the connection but does not send headers, Stop sets a flag but `run()` remains blocked in `fetch()`, and the panel remains busy. Round limits do not bound request duration. Node bootstrap downloads similarly have no timeout/cancellation path.

**Validation:** source tracing; no deliberately stalled external connection was created.

**Fix:** use an abortable HTTP transport with connection/response deadlines, propagate cancellation through bootstrap, and ensure the UI always exits its busy state. Upgrading Electron enables modern abort primitives; a timeout race alone does not cancel an underlying paid request.

### 7. Medium — Retrying a partial Node installation fails with EEXIST

**Location:** `desktop/src/ai/node-runtime.js:130`.

`installNode()` calls `fs.mkdirSync(root, {recursive:true})` in embedded Node 8.2.1. That runtime does not support recursive mkdir. A first attempt can create the single-level directory, but if extraction fails or the managed executable subsequently becomes unusable, a retry downloads the ZIP again and fails at the existing directory before extraction. The Settings module already contains an old-runtime-compatible directory helper, but this path still uses the incompatible call.

**Validation:** the actual bundled Electron executable in Node mode throws `EEXIST` for this exact call on a temporary existing directory. No Node download was performed.

**Fix:** reuse compatible directory creation, extract into a temporary staging directory, validate the runtime, and install atomically. Check all managed runtime candidates rather than stopping at the first executable found.

## Other observations and limits

- Root `npm audit --json`: zero reported vulnerabilities. Desktop `npm audit --omit=dev --json`: 12 dependency entries (2 critical, 5 high, 5 moderate). These counts include dependency-chain effects and are not 12 demonstrated exploitable paths. Production-only audit also does not adequately represent the shipped Electron binary declared under devDependencies.
- Plaintext API-key storage is explicitly disclosed in the release notes. Use OS-backed credential storage and avoid renderer access during the isolation work. No real credential file was read.
- PDF attachments invoke bundled PDF.js v1.10.100 in the privileged renderer. Text extraction parses the whole document before truncation; the byte cap does not bound decompression, page count, or CPU time. Isolate parsing and impose resource limits. No PDF code-execution vulnerability is claimed: the text-extraction path was not shown to reach vulnerable glyph-rendering code.
- Attachments are treated as instructions and tool calls execute without a separate policy boundary. Treat document content as untrusted reference material and constrain project scope in code. No successful prompt-injection attack was demonstrated.
- Screenshots are displayed to the user but replaced with a text placeholder in model history. The assistant cannot perform the visual verification requested by its system prompt under this implementation.
- Positive controls: typed MCP inputs; parameterized SQL in reviewed service paths; JSON serialization of bridge arguments; static SVG element restrictions; revision checks; backups before writes; textContent for chat/attachment rendering; fixed HTTPS provider endpoints.

## Reproduction and verification

Run from the repository root:

```powershell
npm test
node audit/reproduce.mjs
```

All six existing tests passed. The offline audit probes confirmed missing reasoning, incomplete cancellation history, simultaneous independent locks, and old-runtime mkdir behavior. The probe expects the existing generated `desktop/mcp` copy; the runtime-specific check runs when its Electron binary is installed. Lock probes briefly create normal lock files and remove them on completion; they do not connect to the editor.

Semgrep was unavailable. Review used targeted source searches, manual data-flow tracing, npm advisories, actual embedded-runtime behavior, and isolated mock probes. No full GUI/installer test, live concurrency stress test, paid AI end-to-end test, or comprehensive upstream ScratchJr review was performed.
