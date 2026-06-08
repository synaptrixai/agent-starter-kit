# Instructions For Coding Agents

Use this directory as the reference template for creating an installable external agent for the Spilli VS Code extension.

Your goal when generating a new agent repo is to produce a clean clone that the extension can install and load without hidden build assumptions.

## Required Files

Every installable agent repo must contain:

- `spilli-agent.json` at repo root.
- The runtime entrypoint referenced by `agent.loopEntry`.
- Every local tool module referenced by `localToolEntries`.
- Any runtime dependency files required by the entrypoint.
- A smoke test or load check.

Do not rely on uncommitted generated files. If the manifest points to `dist/agentLoop.js`, then `dist/agentLoop.js` and every file it requires must be present in the published repo.

## Manifest Contract

Create `spilli-agent.json` with this shape:

```json
{
  "schemaVersion": 1,
  "runtimeApiVersion": 1,
  "agent": {
    "id": "my-agent-id",
    "name": "My Agent",
    "apiVersion": 1,
    "description": "Short description shown in Spilli.",
    "loopEntry": "agentLoop.js"
  },
  "localToolEntries": [
    "tools/myTools.js"
  ],
  "toolDeps": []
}
```

Rules:

- `schemaVersion`, `runtimeApiVersion`, and `agent.apiVersion` must be `1`.
- `agent.id` must not contain path separators or `..`.
- `agent.loopEntry` is relative to repo root and must exist.
- `agent.iconPath` is optional. If present, it must be a relative path to an existing file in the repo.
- Each `localToolEntries` path is relative to repo root and must exist.

## Runtime Entrypoint

Prefer CommonJS for compatibility with the extension worker:

```js
'use strict';

function createAgentRuntime(context) {
  return {
    async runTurn(request, hooks = {}) {
      // agent loop
      return {
        raw: 'final raw text',
        content: 'final display text',
        isHarmony: false,
        runtime: {
          mode: 'external',
          agentId: 'my-agent-id'
        }
      };
    }
  };
}

module.exports = { createAgentRuntime };
```

The extension accepts either:

- `module.exports.createAgentRuntime = function createAgentRuntime(context) { return { runTurn }; }`
- `module.exports.runTurn = async function runTurn(request, hooks, context) { }`

The starter uses `createAgentRuntime(context)`.

## Request Shape

`runTurn(request, hooks)` receives:

```js
{
  model: 'selected-model-id',
  scope: 'public',
  team: undefined,
  query: 'user message',
  conversationId: 'conversation id',
  conversationSummary: 'optional summary',
  recentMessages: [
    { role: 'user', content: '...' },
    { role: 'assistant', content: '...' }
  ],
  hostEnvironment: {
    platform: 'linux',
    arch: 'x64',
    preferredShell: 'bash',
    shellWrapperHint: '...',
    isWindows: false
  },
  iterationSettings: {
    maxIterations: 4,
    ignoreMaxIterations: false
  }
}
```

Treat optional fields as optional. Keep the agent backward-compatible when `hostEnvironment`, `recentMessages`, or `iterationSettings` are missing.

`iterationSettings.maxIterations` is the extension-configured turn boundary. When `iterationSettings.ignoreMaxIterations === true`, the user has enabled unlimited turns in the extension UI, so the agent must not apply its own hidden max-iteration stop. Continue until the model returns final text, the user cancels, or a tool/runtime error forces a normal finish.

## Runtime Context APIs

The extension passes these APIs to external agents:

```js
await context.runModel({
  prompt,
  query,
  model: request.model,
  scope: request.scope,
  team: request.team
});
```

Returns:

```js
{
  raw: 'exact model response text',
  content: 'display-rendered response text',
  isHarmony: false
}
```

Use `raw` for parser input. Use `content` for user-facing final display when appropriate.

```js
await context.parseToolCalls({
  raw: modelRun.raw,
  content: modelRun.content,
  model: request.model
});
```

Returns normalized tool calls:

```js
[
  {
    toolName: 'workspace.readFile',
    callId: 'call1',
    args: { path: 'README.md' }
  }
]
```

```js
await context.executeToolCall({
  toolName: 'workspace.readFile',
  callId: 'call1',
  args: { path: 'README.md' }
});
```

Returns:

```js
{
  callId: 'call1',
  toolName: 'workspace.readFile',
  ok: true,
  result: 'tool result payload',
  error: undefined
}
```

```js
context.reportStatus?.({
  phase: 'working',
  message: 'Indexing candidate files.',
  detail: 'Scanning src/ and tests/',
  progress: 0.4
});
```

`context.reportStatus` is optional for backward compatibility. Prefer `hooks.onStatus` inside `runTurn`; use `context.reportStatus` from helper functions that do not receive the `hooks` object.

## Ownership Rules

For external agents, the extension is the model transport and tool execution layer. Your agent owns the loop policy:

- Build the system prompt and user query.
- Call `context.runModel()`.
- Decide whether the model output is final text or tool calls.
- Prefer `context.parseToolCalls()` for shared parsing.
- Execute selected tool calls with `context.executeToolCall()`.
- Feed tool results back into the next model call.
- Respect `request.iterationSettings`: stop at `maxIterations` only when `ignoreMaxIterations` is not true.
- Emit status updates while doing background work so the UI can show what is happening.

The extension does not automatically execute tool calls for external agents. Parsed calls are only suggestions until your loop executes them.

When `ignoreMaxIterations` is false and the loop reaches `maxIterations`, returning control is correct: the extension can ask the user whether to continue for another cycle. When `ignoreMaxIterations` is true, do not stop just because the starter's default max would have been reached.

## Agent Status Updates

Agents should emit status updates whenever the user would otherwise stare at a quiet UI while work is happening.

Use this shape:

```js
hooks.onStatus?.({
  phase: 'model',
  message: 'Waiting for model response.',
  detail: 'Asking the selected model to choose the next tool.',
  iteration: 2,
  toolName: undefined,
  progress: 0.25,
  metadata: { source: 'agent-loop' }
});
```

Supported `phase` values:

- `planning`: deciding next steps or building prompts.
- `waiting`: waiting on an external process that is not the model.
- `model`: waiting on AI inference.
- `tool`: executing a tool.
- `working`: processing, parsing, searching, indexing, or otherwise doing local background work.
- `finalizing`: preparing the final answer.
- `done`: optional completion marker before returning.
- `error`: optional recoverable error status before returning or retrying.

Field rules:

- `phase` and `message` are required.
- `message` should be short and user-facing.
- `detail` can contain one extra sentence for hover/transcript/debug use.
- `iteration` should be the current agent loop turn, usually 1-based.
- `toolName` should be set while running or processing a tool.
- `progress` is optional and should be a number from `0` to `1`.
- `metadata` is optional structured data for transcripts/debugging. Do not put secrets in it.

Recommended status points:

- Before building or revising the prompt: `planning`.
- Immediately before `context.runModel`: `model`.
- Before parsing model output: `working`.
- Before each `context.executeToolCall`: `tool`.
- After a long tool result is received and summarized: `working`.
- Before returning final text: `finalizing`.

The extension displays these as a compact status chip on the active assistant bubble and writes them to transcripts as `agent.status`.

## Model Output Formats

Different models may emit different tool-call formats. Do not hard-code a single provider format.

The shared parser may recognize:

- Harmony tool calls.
- Direct JSON envelopes:
  `{"toolName":"starter.projectMap","callId":"call1","args":{"path":"."}}`
- JSON arrays or envelopes:
  `{"toolCalls":[{"toolName":"workspace.readFile","callId":"call1","args":{"path":"README.md"}}]}`
- Markdown fenced JSON.
- OpenAI Responses-style function calls.
- Chat-style `tool_calls` payloads.

Always keep a small local fallback parser if you want compatibility with older extension versions where `context.parseToolCalls` may not exist.

## Hooks

Call hooks when available so the extension UI and transcripts can show what the agent did:

```js
hooks.onModelRequest?.({ iteration, prompt, query });
hooks.onModelResponse?.({
  iteration,
  raw: modelRun.raw,
  content: modelRun.content,
  isHarmony: modelRun.isHarmony === true
});
hooks.onStatus?.({
  phase: 'tool',
  message: 'Running tool.',
  iteration,
  toolName: call.toolName
});
hooks.onToolCall?.(call);
hooks.onToolResult?.(result);
hooks.onChunk?.({
  chunk: text,
  raw: accumulatedRaw,
  display: accumulatedDisplay,
  isHarmony: false
});
```

Only call a hook after checking it exists.

## Local Tool Module Contract

Each local tool module should export `toolModule`, `default`, or the module object itself:

```js
'use strict';

const toolModule = {
  id: 'my-tools',
  tools: [
    {
      contract: {
        name: 'myAgent.someTool',
        description: 'Describe exactly what the tool does.',
        args: '{"path": string}',
        returns: '{"ok": boolean}',
        notes: 'Mention important limits or safety behavior.',
        includeByDefault: true,
        keywords: ['search terms', 'agent should know']
      },
      createTool: context => ({
        async invoke(input) {
          return JSON.stringify({ ok: true });
        }
      })
    }
  ]
};

module.exports = toolModule;
module.exports.toolModule = toolModule;
module.exports.default = toolModule;
```

Tool implementation rules:

- Return strings from `invoke()`. JSON strings are easiest for agents to reuse.
- Validate all inputs.
- Keep file paths inside `context.workspaceRoot`.
- Bound reads, searches, and command execution.
- Prefer read-only examples unless the user explicitly needs write behavior.
- Use unique tool names, ideally prefixed by the agent id.

## Useful Built-In Tools

The extension may provide built-in tools such as:

- `ide.getActiveEditorContext`
- `workspace.searchText`
- `workspace.readFile`
- `workspace.proposeEdit`
- `workspace.applyApprovedEdit`
- `container.runCommand`

Availability can vary by extension version and workspace policy. Agent prompts should describe desired tool names, but agent loops should tolerate failed tool execution results.

## Minimal Loop Pattern

Use this pattern unless the user asks for a different loop:

1. Build a system prompt that explains the agent role and available tools.
2. Build the query from the user request plus recent tool results.
3. Emit `hooks.onStatus({ phase: 'model', message: 'Waiting for model response.', iteration })`.
4. Call `context.runModel()`.
5. Emit `hooks.onModelResponse`.
6. Emit `hooks.onStatus({ phase: 'working', message: 'Inspecting model output for tool calls.', iteration })`.
7. Call `context.parseToolCalls()` if available.
8. If no tool calls are returned, emit `finalizing` and finish with `{ raw, content, isHarmony }`.
9. For each tool call, emit `tool`, emit `hooks.onToolCall`, call `context.executeToolCall`, then emit `hooks.onToolResult`.
10. Repeat with tool results.
11. If `request.iterationSettings.ignoreMaxIterations !== true`, return control after `request.iterationSettings.maxIterations` or a conservative default like `4`; the extension may ask the user whether to continue.
12. If `request.iterationSettings.ignoreMaxIterations === true`, do not enforce that local cap. Continue until the model produces final text or cancellation/error handling ends the turn.

## Tests To Create

At minimum, add a Node smoke test that verifies:

- `spilli-agent.json` parses.
- `agent.loopEntry` exists.
- Every `localToolEntries` file exists.
- `require(agent.loopEntry)` succeeds.
- `createAgentRuntime(fakeContext).runTurn(fakeRequest)` returns `{ raw, content, isHarmony }`.
- The loop can parse and execute one fake tool call.
- Status updates are emitted around model waits and tool execution.
- Local tool modules expose `{ id, tools }` and each sample tool can be invoked with valid input.

## Clean-Clone Packaging Check

Before finishing a generated agent, run:

```sh
node -e "require('./agentLoop.js'); console.log('runtime-load-ok')"
npm test
```

If using a `dist/` entrypoint, run the load check against the actual manifest entry:

```sh
node -e "require('./dist/agentLoop.js'); console.log('runtime-load-ok')"
```

## Common Mistakes

- Manifest points to `dist/agentLoop.js`, but `dist/` was not committed.
- Runtime uses ESM-only syntax but is loaded through CommonJS `require()`.
- Tool module path in `localToolEntries` is wrong after packaging.
- Agent parses only Harmony and fails on JSON or Responses-style tool calls.
- Agent expects the extension to auto-execute parsed tool calls.
- Agent does not emit hook events, making transcripts hard to debug.
- Agent does long background work without `hooks.onStatus` or `context.reportStatus`.
- Tool reads outside the workspace root.
- Loop ignores `request.iterationSettings.ignoreMaxIterations` and stops despite the extension's unlimited-turn setting.
- Loop has no finite boundary when `ignoreMaxIterations` is false, preventing the extension from asking the user whether to continue.

## When Modifying This Starter

Keep this starter:

- Dependency-free unless a dependency is truly necessary.
- Installable from a clean clone.
- Focused on external runtime compatibility.
- Rich enough that a coding agent can copy it and create a working new agent without reading the extension source.
