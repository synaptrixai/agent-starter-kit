'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('manifest references files that exist', () => {
  const manifestPath = path.join(repoRoot, 'spilli-agent.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.strictEqual(manifest.schemaVersion, 1);
  assert.strictEqual(manifest.runtimeApiVersion, 1);
  assert.strictEqual(manifest.agent.apiVersion, 1);
  assert.ok(fs.existsSync(path.join(repoRoot, manifest.agent.loopEntry)));

  for (const entry of manifest.localToolEntries) {
    assert.ok(fs.existsSync(path.join(repoRoot, entry)), `missing local tool entry: ${entry}`);
  }
});

test('runtime loads and executes a parsed tool call', async () => {
  const { createAgentRuntime } = require('../agentLoop');
  const events = [];
  const statuses = [];
  let modelCalls = 0;

  const runtime = createAgentRuntime({
    runtimeApiVersion: 1,
    manifest: {},
    async runModel() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          raw: '{"toolName":"starter.projectMap","callId":"call1","args":{"path":".","maxDepth":1}}',
          content: '{"toolName":"starter.projectMap","callId":"call1","args":{"path":".","maxDepth":1}}',
          isHarmony: false
        };
      }
      return {
        raw: 'The project map shows a README and an agent loop.',
        content: 'The project map shows a README and an agent loop.',
        isHarmony: false
      };
    },
    async parseToolCalls(payload) {
      if (!payload.raw.includes('"toolName"')) {
        return [];
      }
      return [
        {
          toolName: 'starter.projectMap',
          callId: 'call1',
          args: { path: '.', maxDepth: 1 }
        }
      ];
    },
    async executeToolCall(call) {
      return {
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        result: { entries: [{ path: 'README.md', type: 'file' }] }
      };
    }
  });

  const result = await runtime.runTurn(
    {
      model: 'test-model',
      scope: 'public',
      query: 'Inspect the project.',
      conversationId: 'conversation-1',
      iterationSettings: { maxIterations: 3 }
    },
    {
      onToolCall: call => events.push(['call', call.toolName]),
      onToolResult: toolResult => events.push(['result', toolResult.ok]),
      onStatus: status => statuses.push([status.phase, status.message])
    }
  );

  assert.strictEqual(modelCalls, 2);
  assert.deepStrictEqual(events, [
    ['call', 'starter.projectMap'],
    ['result', true]
  ]);
  assert.ok(statuses.some(([phase]) => phase === 'planning'));
  assert.ok(statuses.some(([phase]) => phase === 'model'));
  assert.ok(statuses.some(([phase]) => phase === 'tool'));
  assert.ok(statuses.some(([phase]) => phase === 'finalizing'));
  assert.strictEqual(result.content, 'The project map shows a README and an agent loop.');
  assert.strictEqual(result.runtime.mode, 'external');
});

test('runtime honors ignoreMaxIterations from the extension request', async () => {
  const { createAgentRuntime, _private } = require('../agentLoop');
  let modelCalls = 0;

  assert.strictEqual(
    _private.getIterationLimit({ iterationSettings: { maxIterations: 1, ignoreMaxIterations: true } }),
    Number.POSITIVE_INFINITY
  );

  const runtime = createAgentRuntime({
    runtimeApiVersion: 1,
    manifest: {},
    async runModel() {
      modelCalls += 1;
      if (modelCalls < 3) {
        return {
          raw: `{"toolName":"starter.projectMap","callId":"call${modelCalls}","args":{"path":"."}}`,
          content: `{"toolName":"starter.projectMap","callId":"call${modelCalls}","args":{"path":"."}}`,
          isHarmony: false
        };
      }
      return {
        raw: 'Finished after continuing past the configured one-turn boundary.',
        content: 'Finished after continuing past the configured one-turn boundary.',
        isHarmony: false
      };
    },
    async parseToolCalls(payload) {
      if (!payload.raw.includes('"toolName"')) {
        return [];
      }
      const callId = payload.raw.includes('"call2"') ? 'call2' : 'call1';
      return [{ toolName: 'starter.projectMap', callId, args: { path: '.' } }];
    },
    async executeToolCall(call) {
      return {
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        result: { entries: [] }
      };
    }
  });

  const result = await runtime.runTurn({
    model: 'test-model',
    scope: 'public',
    query: 'Keep inspecting until done.',
    conversationId: 'conversation-2',
    iterationSettings: { maxIterations: 1, ignoreMaxIterations: true }
  });

  assert.strictEqual(modelCalls, 3);
  assert.strictEqual(result.content, 'Finished after continuing past the configured one-turn boundary.');
});

test('starter local tools expose extension-compatible tool module shape', async () => {
  const starterTools = require('../tools/starterTools');
  assert.strictEqual(starterTools.id, 'starter-tools');
  assert.ok(Array.isArray(starterTools.tools));

  const toolNames = starterTools.tools.map(tool => tool.contract.name).sort();
  assert.deepStrictEqual(toolNames, [
    'starter.findTodos',
    'starter.projectMap',
    'starter.readTextSlice'
  ]);
});

test('starter project map and text tools return useful workspace data', async () => {
  const starterTools = require('../tools/starterTools');
  const context = {
    workspaceRoot: repoRoot,
    maxBytesPerRead: 16 * 1024,
    maxSearchResults: 20
  };

  const byName = new Map(starterTools.tools.map(tool => [tool.contract.name, tool]));

  const projectMap = JSON.parse(await byName.get('starter.projectMap').createTool(context).invoke({
    path: '.',
    maxDepth: 1,
    maxEntries: 20
  }));
  assert.ok(projectMap.entries.some(entry => entry.path === 'README.md'));
  assert.ok(projectMap.entries.some(entry => entry.path === 'agentLoop.js'));

  const readmeSlice = JSON.parse(await byName.get('starter.readTextSlice').createTool(context).invoke({
    path: 'README.md',
    startLine: 1,
    maxLines: 3
  }));
  assert.strictEqual(readmeSlice.path, 'README.md');
  assert.ok(readmeSlice.lines[0].text.includes('Spilli Agent Starter Kit'));

  const todos = JSON.parse(await byName.get('starter.findTodos').createTool(context).invoke({
    path: '.',
    maxResults: 5,
    maxFiles: 20
  }));
  assert.ok(Array.isArray(todos.matches));
});
