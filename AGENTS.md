# Instructions For Coding Agents

Use this repository as the reference template for creating an installable external agent for the Spilli VS Code extension.

Your goal is to produce a self-contained Git repo that the extension can clone, install, and load without running hidden setup steps.

## Compatibility Rules

Every installable agent repo must contain:

- `spilli-agent.json` at repo root.
- The runtime entrypoint referenced by `agent.loopEntry`.
- Every file required by the runtime entrypoint.
- Every local tool module referenced by `localToolEntries`.
- A smoke test or load check.

Do not rely on uncommitted generated files. If the manifest points to `dist/agentLoop.js`, then `dist/agentLoop.js` and all of its required files must be present in the published repo.

Prefer CommonJS runtime files unless the repo has already proven that its module format loads correctly from plain Node.

## Manifest Contract

Create or preserve `spilli-agent.json` with this shape:

```json
{
  "schemaVersion": 1,
  "runtimeApiVersion": 1,
  "agent": {
    "id": "my-agent-id",
    "name": "My Agent",
    "apiVersion": 1,
    "loopEntry": "agentLoop.js",
    "description": "Short description shown in Spilli."
  },
  "localToolEntries": [
    "tools/myTools.js"
  ],
  "toolDeps": []
}
```

Rules:

- `schemaVersion`, `runtimeApiVersion`, and `agent.apiVersion` must be `1`.
- `agent.id` must be stable and must not contain `/`, `\`, or `..`.
- `agent.loopEntry` is relative to repo root and must exist in a clean clone.
- `agent.description`, `agent.iconName`, and `agent.iconPath` are optional.
- `agent.iconPath`, when present, must be relative and must point to an existing file in the repo.
- Every `localToolEntries` path is relative to repo root and must exist.
- Leave `toolDeps` empty unless the agent intentionally depends on separately published tool repos.

## Runtime Entrypoint

The extension accepts either export shape:

```js
'use strict';

function createAgentRuntime(context) {
  return {
    async runTurn(request, hooks = {}) {
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

or:

```js
module.exports.runTurn = async function runTurn(request, hooks = {}, context) {
  return {
    raw: 'final raw text',
    content: 'final display text',
    isHarmony: false
  };
};
```

The starter uses `createAgentRuntime(context)`.

## Request Shape

`runTurn(request, hooks)` receives a task request like:

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
  content: [
    { type: 'text', text: 'user message' }
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

Treat optional fields as optional. Keep the agent compatible when `recentMessages`, `content`, `hostEnvironment`, or `iterationSettings` are missing.

`iterationSettings.maxIterations` is the extension-configured turn boundary. When `iterationSettings.ignoreMaxIterations === true`, the user enabled unlimited turns; do not add a hidden local max-iteration stop in that mode.

## Runtime Context APIs

The context object provides public helper APIs:

```js
const modelRun = await context.runModel({
  prompt,
  query,
  content,
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

Use `raw` for parser input. Use `content` for user-facing final display when appropriate. `runModel()` does not return parsed tool calls.

```js
const toolCalls = await context.parseToolCalls({
  raw: modelRun.raw,
  content: modelRun.content,
  model: request.model
});
```

Returns normalized tool-call envelopes:

```js
[
  {
    toolName: 'workspace.readFile',
    callId: 'call1',
    args: { path: 'README.md' }
  }
]
```

`parseToolCalls()` only parses. The agent still decides whether to execute, ignore, retry, or finish.

```js
const result = await context.executeToolCall({
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

`context.reportStatus(status)` may be used from helper functions that do not receive `hooks`.

## Loop Ownership

For external agents, the extension is the model transport and tool execution layer. The agent owns the loop policy:

- Build the system prompt and user query.
- Call `context.runModel()`.
- Decide whether the model output is final text or tool calls.
- Prefer `context.parseToolCalls()` for shared parsing.
- Execute selected tool calls with `context.executeToolCall()`.
- Feed tool results back into later model calls.
- Respect `request.iterationSettings`.
- Return `{ raw, content, isHarmony }` when the turn is complete.

The extension does not automatically execute tool calls for external agents.

## Status And Event Hooks

Emit status updates whenever the user would otherwise see a quiet UI while work is happening:

```js
hooks.onStatus?.({
  phase: 'model',
  message: 'Waiting for model response.',
  detail: 'Asking the selected model to choose the next step.',
  iteration: 2,
  progress: 0.25,
  metadata: { source: 'agent-loop' }
});
```

Supported `phase` values:

- `planning`
- `waiting`
- `model`
- `tool`
- `working`
- `finalizing`
- `done`
- `error`

Field rules:

- `phase` and `message` are required.
- `message` should be short and user-facing.
- `detail` can contain one extra sentence for transcript/debug context.
- `iteration` should be the current agent loop turn, usually 1-based.
- `toolName` should be set while running or processing a tool.
- `progress` is optional and should be a number from `0` to `1`.
- `metadata` is optional structured data. Do not put secrets in it.

Also use:

- `hooks.onModelRequest({ iteration, prompt, query, content })` before model calls when useful.
- `hooks.onModelResponse({ iteration, raw, content, isHarmony })` after model calls.
- `hooks.onToolCall(call)` before executing a tool.
- `hooks.onToolResult(result)` after a tool returns.
- `hooks.onChunk(chunk)` only for user-visible streamed output.
- `hooks.onEditProposal(proposal)` only when your runtime creates a reviewable edit proposal.

## Local Tool Modules

Use `localToolEntries` only for agent-specific tools. Shared workspace, IDE, and container-oriented tools may be available through `context.executeToolCall()` depending on the user's environment and permissions; do not copy those built-ins into the agent repo.

Each local tool module should export a module directly, as `toolModule`, or as `default`:

```js
'use strict';

const toolModule = {
  id: 'my-agent-tools',
  tools: [
    {
      contract: {
        name: 'myAgent.inspect',
        description: 'Inspect something specific to this agent.',
        args: '{"path": string}',
        returns: '{"ok": boolean, "summary": string}',
        includeByDefault: true,
        keywords: ['inspect']
      },
      createTool: context => ({
        async invoke(input) {
          return JSON.stringify({ ok: true, summary: String(input.path || '') });
        }
      })
    }
  ]
};

module.exports = toolModule;
module.exports.toolModule = toolModule;
module.exports.default = toolModule;
```

Tool guidance:

- Namespace tool names, for example `myAgent.inspect`.
- Keep tool arguments JSON-serializable.
- Return text or JSON-serialized text.
- Resolve file paths inside `context.workspaceRoot` or `process.cwd()`.
- Keep tools bounded: limit bytes, lines, entries, and command duration.
- Avoid secrets in results, errors, status metadata, or transcripts.

## Prompting Guidance

When adapting this starter:

- Teach the model the tool-call format your loop can parse.
- Include only the tools the agent should actually use.
- Explain when to answer directly instead of calling tools.
- Feed compact tool results back into later model calls.
- Avoid exposing extension internals or implementation file paths in user-facing prompts.

Useful generic tool-call JSON:

```json
{"toolName":"starter.projectMap","callId":"call1","args":{"path":".","maxDepth":2}}
```

The extension's shared parser can also recognize other common formats, but agents should keep their own prompts simple and consistent.

## Validation Checklist

Before finishing changes:

1. Run `npm test`.
2. Run `npm run smoke` or `node -e "require('./agentLoop.js'); console.log('runtime-load-ok')"`.
3. Fresh clone the repo into a temp directory and repeat the checks.
4. Confirm `spilli-agent.json` exists at repo root.
5. Confirm `agent.loopEntry` exists in the clean clone.
6. Confirm every `localToolEntries` path exists in the clean clone.
7. Confirm generated runtime dependencies are committed if the manifest points at generated output.

## Common Failure Mode

Symptom:

- Startup fails with a missing module error.

Cause:

- The manifest entrypoint was committed without one of the files it requires.

Fix:

- Commit the missing dependency file.
- Rerun a clean-clone smoke test before publishing.
