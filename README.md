# Spilli Agent Starter Kit

This directory is a minimal installable external agent for the Spilli VS Code extension. Use it as a template when creating a new agent repo.

The starter shows:
- A valid `spilli-agent.json` manifest.
- A CommonJS `agentLoop.js` runtime entrypoint.
- Local tools exposed through `localToolEntries`.
- A simple multi-iteration loop that calls the selected model, asks the extension's shared parser for tool calls, executes tools, and returns a final message.
- A dependency-free smoke test.
- `AGENTS.md` instructions for coding agents that need to create compatible Spilli agents.

## Files

- `spilli-agent.json`: extension manifest.
- `agentLoop.js`: runtime entrypoint loaded by the extension worker.
- `tools/starterTools.js`: sample local tool module.
- `tests/smoke.test.js`: Node test covering manifest shape, runtime loading, model parsing, and tool execution.
- `AGENTS.md`: coding-agent instructions with the manifest, runtime, parser, tool, hook, and packaging contracts.
- `package.json`: convenience scripts.

If you are asking a coding agent to create a new Spilli-compatible agent, point it at `AGENTS.md` first.

## Runtime Contract

The extension loads the file referenced by `agent.loopEntry` and expects one of:

```js
exports.createAgentRuntime = function createAgentRuntime(context) {
  return {
    async runTurn(request, hooks) {
      // ...
    }
  };
};
```

or:

```js
exports.runTurn = async function runTurn(request, hooks, context) {
  // ...
};
```

The starter uses `createAgentRuntime(context)`.

## Context APIs

External agents receive:

- `context.runModel({ prompt, query, model, scope, team })`
- `context.parseToolCalls({ raw, content, model })`
- `context.executeToolCall({ toolName, callId, args })`
- `context.reportStatus({ phase, message, ... })`

`runModel()` is the transport boundary. It returns raw model text plus display-rendered content:

```js
{
  raw: 'exact model payload',
  content: 'display-rendered text',
  isHarmony: false
}
```

The agent decides whether to execute tools. The extension does not automatically execute parsed tool calls for external agents.

The extension passes iteration settings to the agent request. If `request.iterationSettings.ignoreMaxIterations` is true, the user enabled unlimited turns, so the starter loop does not apply its default local cap. If it is false or missing, the starter returns control after `request.iterationSettings.maxIterations` or a conservative default so the extension can ask the user whether to continue.

Agents should also emit background status updates with `hooks.onStatus(...)` while planning, waiting for model inference, parsing output, running tools, or finalizing. The extension renders these as a compact status chip on the active assistant bubble and records them in transcripts as `agent.status`.

## Tool-Call Strategy

Different models may emit different shapes:

- Harmony tool calls.
- Direct JSON envelopes like `{"toolName":"starter.projectMap","callId":"call1","args":{"path":".","maxDepth":2}}`.
- `{ "toolCalls": [...] }`.
- Markdown JSON blocks.
- OpenAI Responses-style function calls.
- Plain final text.

Prefer `context.parseToolCalls({ raw, content, model })` so agents share the extension parser. Keep a small local fallback for older extension versions, as shown in `agentLoop.js`.

## Local Tools

This starter includes read-only local tools that are useful enough to run in real agent experiments:

- `starter.projectMap`: returns a compact tree under a workspace path.
- `starter.readTextSlice`: reads a bounded line-numbered slice of a text file.
- `starter.findTodos`: scans text files for `TODO`, `FIXME`, `HACK`, and `NOTE`.

Each path in `localToolEntries` must export either `default` or `toolModule` with this shape:

```js
module.exports.toolModule = {
  id: 'starter-tools',
  tools: [
    {
      contract: {
        name: 'starter.projectMap',
        description: 'Return a compact tree of workspace files and directories under a path.',
        args: '{"path"?: string, "maxDepth"?: number, "maxEntries"?: number}',
        returns: '{"root": string, "entries": Array<{path, type, size?}>, "truncated": boolean}',
        includeByDefault: true
      },
      createTool: context => ({
        async invoke(input) {
          // Resolve paths inside context.workspaceRoot and return JSON text.
        }
      })
    }
  ]
};
```

The extension also provides its built-in tools, such as workspace, IDE, and container tools, depending on configuration and permissions.

## Try The Starter

From this directory:

```sh
npm test
node -e "require('./agentLoop.js'); console.log('runtime-load-ok')"
```

To publish your own agent:

1. Copy this directory into a new Git repo.
2. Change `agent.id`, `agent.name`, and `agent.description` in `spilli-agent.json`.
3. Customize `buildSystemPrompt()` and `buildUserQuery()` in `agentLoop.js`.
4. Add local tools under `tools/` and list them in `localToolEntries`.
5. Run `npm test`.
6. Install the repo through the Spilli extension agent installer.

## Packaging Checklist

- `spilli-agent.json` exists at repo root.
- `agent.loopEntry` exists in a clean clone.
- Every `localToolEntries` path exists in a clean clone.
- Runtime entrypoint loads with `node -e "require('./agentLoop.js')"`.
- Tests pass with `npm test`.
