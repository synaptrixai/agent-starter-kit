'use strict';

const DEFAULT_MAX_ITERATIONS = 4;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function makeCallId(iteration, index) {
  return `starter-${iteration}-${index}-${Date.now().toString(36)}`;
}

function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function localFallbackParseToolCalls(raw) {
  const calls = [];
  const text = typeof raw === 'string' ? raw : '';

  for (const objectText of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(objectText);
      const candidates = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [parsed];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object' || typeof candidate.toolName !== 'string') {
          continue;
        }
        calls.push({
          toolName: candidate.toolName,
          callId: typeof candidate.callId === 'string' ? candidate.callId : makeCallId(0, calls.length + 1),
          args: asRecord(candidate.args)
        });
      }
    } catch {
      // Ignore malformed JSON fragments. The shared extension parser is preferred when available.
    }
  }

  return calls;
}

async function parseToolCalls(context, modelRun, model) {
  if (context && typeof context.parseToolCalls === 'function') {
    try {
      return await context.parseToolCalls({
        raw: modelRun.raw,
        content: modelRun.content,
        model
      });
    } catch {
      return localFallbackParseToolCalls(modelRun.raw);
    }
  }
  return localFallbackParseToolCalls(modelRun.raw);
}

function buildSystemPrompt(request) {
  const host = request.hostEnvironment || {};
  return [
    'You are a starter external coding agent for the Spilli VS Code extension.',
    '',
    'You can answer directly or request tools. When requesting a tool, emit a tool-call payload that the agent loop can parse.',
    '',
    'Preferred tool-call JSON shape:',
    '{"toolName":"starter.projectMap","callId":"call1","args":{"path":".","maxDepth":2}}',
    '',
    'Useful sample local tools:',
    '- starter.projectMap: inspect a compact workspace tree.',
    '- starter.readTextSlice: read a bounded line-numbered slice of a text file.',
    '- starter.findTodos: scan workspace text files for TODO, FIXME, HACK, and NOTE comments.',
    '',
    'Useful built-in Spilli tools may include:',
    '- ide.getActiveEditorContext',
    '- workspace.searchText',
    '- workspace.readFile',
    '- workspace.proposeEdit',
    '- container.runCommand',
    '',
    `Host platform: ${host.platform || 'unknown'}`,
    `Preferred shell: ${host.preferredShell || 'unknown'}`,
    '',
    'After tool results are provided, produce a final response for the user.'
  ].join('\n');
}

function buildUserQuery(request, toolResults) {
  if (!toolResults.length) {
    return request.query;
  }

  return [
    request.query,
    '',
    'Tool results so far:',
    safeJson(toolResults),
    '',
    'Use these results to decide the next tool call or produce the final response.'
  ].join('\n');
}

function normalizeResult(modelRun, runtime) {
  return {
    raw: typeof modelRun.raw === 'string' ? modelRun.raw : '',
    content: typeof modelRun.content === 'string' ? modelRun.content : String(modelRun.raw || ''),
    isHarmony: modelRun.isHarmony === true,
    runtime
  };
}

function getIterationLimit(request) {
  const settings = request.iterationSettings || {};
  if (settings.ignoreMaxIterations === true) {
    return Number.POSITIVE_INFINITY;
  }

  const configured = Number(settings.maxIterations);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_MAX_ITERATIONS;
}

function createAgentRuntime(context) {
  if (!context || typeof context.runModel !== 'function' || typeof context.executeToolCall !== 'function') {
    throw new Error('Spilli runtime context must provide runModel() and executeToolCall().');
  }

  async function runTurn(request, hooks = {}) {
    const maxIterations = getIterationLimit(request);
    const toolResults = [];
    let lastModelRun = { raw: '', content: '', isHarmony: false };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      hooks.onStatus?.({
        phase: 'planning',
        message: toolResults.length ? 'Reviewing tool results and planning next step.' : 'Planning the first step.',
        iteration
      });

      const prompt = buildSystemPrompt(request);
      const query = buildUserQuery(request, toolResults);

      if (typeof hooks.onModelRequest === 'function') {
        hooks.onModelRequest({ iteration, prompt, query });
      }

      hooks.onStatus?.({
        phase: 'model',
        message: 'Waiting for model response.',
        iteration
      });

      lastModelRun = await context.runModel({
        prompt,
        query,
        model: request.model,
        scope: request.scope,
        team: request.team
      });

      if (typeof hooks.onModelResponse === 'function') {
        hooks.onModelResponse({
          iteration,
          raw: lastModelRun.raw,
          content: lastModelRun.content,
          isHarmony: lastModelRun.isHarmony === true
        });
      }

      hooks.onStatus?.({
        phase: 'working',
        message: 'Inspecting model output for tool calls.',
        iteration
      });

      const toolCalls = await parseToolCalls(context, lastModelRun, request.model);
      if (!toolCalls.length) {
        hooks.onStatus?.({
          phase: 'finalizing',
          message: 'Preparing final response.',
          iteration
        });
        return normalizeResult(lastModelRun, { mode: 'external', agentId: 'spilli-agent-starter' });
      }

      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = {
          toolName: toolCalls[index].toolName,
          callId: toolCalls[index].callId || makeCallId(iteration, index + 1),
          args: asRecord(toolCalls[index].args)
        };

        if (typeof hooks.onToolCall === 'function') {
          hooks.onToolCall(call);
        }

        hooks.onStatus?.({
          phase: 'tool',
          message: 'Running tool.',
          iteration,
          toolName: call.toolName,
          progress: toolCalls.length > 0 ? index / toolCalls.length : undefined
        });

        const result = await context.executeToolCall(call);
        toolResults.push(result);

        if (typeof hooks.onToolResult === 'function') {
          hooks.onToolResult(result);
        }

        hooks.onStatus?.({
          phase: 'working',
          message: 'Tool result received.',
          iteration,
          toolName: call.toolName,
          progress: toolCalls.length > 0 ? (index + 1) / toolCalls.length : undefined
        });
      }
    }

    return normalizeResult(
      {
        raw: lastModelRun.raw,
        content: [
          lastModelRun.content || lastModelRun.raw,
          '',
          'Reached the configured iteration boundary and returned control to the extension. Continue if you want the agent to run another cycle.'
        ].join('\n').trim(),
        isHarmony: lastModelRun.isHarmony === true
      },
      { mode: 'external', agentId: 'spilli-agent-starter' }
    );
  }

  return { runTurn };
}

module.exports = {
  createAgentRuntime,
  _private: {
    buildSystemPrompt,
    buildUserQuery,
    getIterationLimit,
    localFallbackParseToolCalls
  }
};
