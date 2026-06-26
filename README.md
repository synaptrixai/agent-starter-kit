# Spilli Agent Starter Kit

This repository is a minimal installable external agent for the Spilli VS Code extension. Use it as a template when you want to build an agent that owns its own loop policy while using the extension for model transport, workspace tools, IDE-aware tools, and transcript-visible events.

The starter includes:

- `spilli-agent.json`, the install manifest.
- `agentLoop.js`, a CommonJS runtime entrypoint.
- `tools/starterTools.js`, sample agent-specific local tools.
- `tests/smoke.test.js`, dependency-free compatibility tests.
- `AGENTS.md`, instructions you can hand to a coding agent that is creating or modifying a Spilli-compatible agent repo.

## Quick Start

From this directory:

```sh
npm test
npm run smoke
```

To create your own agent:

1. Copy this starter into a new Git repo.
2. Update `agent.id`, `agent.name`, and `agent.description` in `spilli-agent.json`.
3. Customize the prompt and loop policy in `agentLoop.js`.
4. Add agent-specific tools under `tools/` only when the extension's shared tools are not enough.
5. List each local tool module in `localToolEntries`.
6. Run `npm test` in a clean clone before installing the repo in Spilli.

## Required Files

Every installable agent repo needs:

- `spilli-agent.json` at the repo root.
- The file referenced by `agent.loopEntry`.
- Every file required by the runtime entrypoint.
- Every file listed in `localToolEntries`.

If you compile from TypeScript or bundle into `dist/`, commit the generated runtime files that the manifest points at. The extension installs from the repo checkout; it does not run your build step before loading the agent.

## Manifest

`spilli-agent.json` uses schema version `1`:

```json
{
  "schemaVersion": 1,
  "runtimeApiVersion": 1,
  "agent": {
    "id": "spilli-agent-starter",
    "name": "Spilli Agent Starter",
    "apiVersion": 1,
    "loopEntry": "agentLoop.js",
    "description": "Minimal external agent runtime template for the Spilli VS Code extension."
  },
  "localToolEntries": [
    "tools/starterTools.js"
  ],
  "toolDeps": []
}
```

Rules:

- `schemaVersion`, `runtimeApiVersion`, and `agent.apiVersion` must be `1`.
- `agent.id` must be stable and must not contain `/`, `\`, or `..`.
- `agent.loopEntry` must be a repo-relative path to an existing JavaScript module.
- `agent.description`, `agent.iconName`, and `agent.iconPath` are optional display fields.
- `agent.iconPath`, when present, must be a repo-relative path to an existing file.
- `localToolEntries` is optional and should contain only agent-specific tool modules.
- `toolDeps` is reserved for shared tool dependency repos; leave it empty unless you intentionally publish tools that way.

## Runtime Entrypoint

The file referenced by `agent.loopEntry` should export one of these CommonJS shapes:

```js
exports.createAgentRuntime = function createAgentRuntime(context) {
  return {
    async runTurn(request, hooks = {}) {
      return {
        raw: 'final raw text',
        content: 'final display text',
        isHarmony: false
      };
    }
  };
};
```

or:

```js
exports.runTurn = async function runTurn(request, hooks = {}, context) {
  return {
    raw: 'final raw text',
    content: 'final display text',
    isHarmony: false
  };
};
```

The starter uses `createAgentRuntime(context)`.

## Request Shape

`runTurn(request, hooks)` receives the user's task and selected routing information:

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

Treat optional fields as optional. In particular, keep your agent compatible when `recentMessages`, `content`, `hostEnvironment`, or `iterationSettings` are missing.

`iterationSettings.maxIterations` is the extension-configured turn boundary. If `iterationSettings.ignoreMaxIterations === true`, the user has enabled unlimited turns, so do not apply a hidden local cap.

## Runtime Context

External agents receive a context object with these public helpers:

```js
await context.runModel({
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

`runModel()` does not execute tools and does not return parsed tool calls. Your agent decides what the model output means.

```js
await context.parseToolCalls({
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

`parseToolCalls()` is only a parser. The agent still decides which calls to execute.

```js
await context.executeToolCall({
  toolName: 'workspace.readFile',
  callId: 'call1',
  args: { path: 'README.md' }
});
```

Returns a normalized tool result:

```js
{
  callId: 'call1',
  toolName: 'workspace.readFile',
  ok: true,
  result: 'tool result payload',
  error: undefined
}
```

Use `context.reportStatus(status)` from helpers that do not receive `hooks`. Inside `runTurn`, prefer `hooks.onStatus(status)`.

## Hooks And Events

Use hooks to keep the Spilli UI and transcripts aligned with what your loop is doing:

- `hooks.onStatus(status)` for planning, waiting, model, tool, working, finalizing, done, or error updates.
- `hooks.onModelRequest(payload)` before model calls when you want observability.
- `hooks.onModelResponse(payload)` after model calls.
- `hooks.onToolCall(call)` before executing a tool.
- `hooks.onToolResult(result)` after a tool returns.
- `hooks.onChunk(chunk)` if your runtime streams user-visible text.
- `hooks.onEditProposal(proposal)` if your runtime creates reviewable edit proposals.

Status shape:

```js
hooks.onStatus?.({
  phase: 'tool',
  message: 'Running tool.',
  detail: 'Reading README.md',
  iteration: 2,
  toolName: 'workspace.readFile',
  progress: 0.5,
  metadata: { source: 'agent-loop' }
});
```

Supported phases are `planning`, `waiting`, `model`, `tool`, `working`, `finalizing`, `done`, and `error`.

## Local Tools

Local tools are for capabilities specific to your agent. The extension may also provide shared tools such as workspace, IDE, and container-oriented tools depending on the user's environment and permissions. Do not duplicate shared tools in `localToolEntries`.

Each local tool module should export a tool module directly, as `toolModule`, or as `default`:

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

Tool names should be namespaced, for example `starter.projectMap` or `myAgent.inspect`.

## Loop Ownership

For external agents, the extension provides model access and tool execution. Your runtime owns the loop:

1. Build the system prompt and model query.
2. Call `context.runModel()`.
3. Decide whether the model returned final text or tool calls.
4. Prefer `context.parseToolCalls()` for shared parsing.
5. Execute selected calls with `context.executeToolCall()`.
6. Feed tool results into the next model turn.
7. Respect `request.iterationSettings`.
8. Return `{ raw, content, isHarmony }` when the turn is complete.

## Publishing Checklist

Before sharing an agent repo:

- Run `npm test`.
- Run `npm run smoke` or `node -e "require('./agentLoop.js'); console.log('runtime-load-ok')"`.
- Fresh clone the repo and repeat the tests.
- Confirm `spilli-agent.json` exists at repo root.
- Confirm `agent.loopEntry` exists in the fresh clone.
- Confirm every `localToolEntries` path exists in the fresh clone.
- Confirm generated runtime dependencies are committed if the manifest points to generated output.

## Common Failure

If installation or startup fails with a missing module error, the repo usually published an entrypoint without publishing one of the files it requires. Commit the missing file, then rerun the clean-clone smoke test.
