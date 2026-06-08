'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_MAX_DEPTH = 3;
const IGNORED_NAMES = new Set([
  '.git',
  '.vscode-test',
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.next',
  '.turbo'
]);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function getWorkspaceRoot(context) {
  const root = typeof context.workspaceRoot === 'string' && context.workspaceRoot.trim()
    ? context.workspaceRoot
    : process.cwd();
  return path.resolve(root);
}

function assertInsideWorkspace(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error('Requested path must stay inside the workspace root.');
}

function resolveWorkspacePath(context, requestedPath) {
  const root = getWorkspaceRoot(context);
  const requested = typeof requestedPath === 'string' && requestedPath.trim() ? requestedPath.trim() : '.';
  const target = path.resolve(root, requested);
  assertInsideWorkspace(root, target);
  return { root, target };
}

function toWorkspaceRelative(root, target) {
  const relative = path.relative(root, target).replace(/\\/g, '/');
  return relative || '.';
}

function isProbablyTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readBoundedText(filePath, maxBytes) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: fs.statSync(filePath).size > bytesRead
    };
  } finally {
    fs.closeSync(handle);
  }
}

function sortedDirectoryEntries(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => !IGNORED_NAMES.has(entry.name))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

function collectProjectMap(root, start, maxDepth, maxEntries) {
  const entries = [];
  let truncated = false;

  function visit(current, depth) {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }

    const stat = fs.statSync(current);
    const relative = toWorkspaceRelative(root, current);
    entries.push({
      path: relative,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : undefined
    });

    if (!stat.isDirectory() || depth >= maxDepth) {
      return;
    }

    for (const child of sortedDirectoryEntries(current)) {
      visit(path.join(current, child.name), depth + 1);
      if (truncated) {
        return;
      }
    }
  }

  visit(start, 0);
  return { entries, truncated };
}

function walkTextFiles(root, start, maxFiles) {
  const files = [];
  let truncated = false;

  function visit(current) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (isProbablyTextFile(current)) {
        files.push(current);
      }
      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    for (const child of sortedDirectoryEntries(current)) {
      visit(path.join(current, child.name));
      if (truncated) {
        return;
      }
    }
  }

  visit(start);
  return { files, truncated };
}

const toolModule = {
  id: 'starter-tools',
  tools: [
    {
      contract: {
        name: 'starter.projectMap',
        description: 'Return a compact tree of workspace files and directories under a path.',
        args: '{"path"?: string, "maxDepth"?: number, "maxEntries"?: number}',
        returns: '{"root": string, "entries": Array<{path, type, size?}>, "truncated": boolean}',
        notes: 'Read-only. Paths are resolved inside the workspace root. Common build and dependency directories are skipped.',
        includeByDefault: true,
        keywords: ['starter', 'tree', 'project map', 'files', 'workspace']
      },
      createTool: context => ({
        async invoke(input) {
          const { root, target } = resolveWorkspacePath(context, input.path);
          const maxDepth = clampInteger(input.maxDepth, DEFAULT_MAX_DEPTH, 0, 8);
          const maxEntries = clampInteger(input.maxEntries, DEFAULT_MAX_ENTRIES, 1, 500);
          if (!fs.existsSync(target)) {
            throw new Error(`Path not found: ${toWorkspaceRelative(root, target)}`);
          }
          const result = collectProjectMap(root, target, maxDepth, maxEntries);
          return JSON.stringify({
            root: toWorkspaceRelative(root, target),
            entries: result.entries,
            truncated: result.truncated
          });
        }
      })
    },
    {
      contract: {
        name: 'starter.readTextSlice',
        description: 'Read a bounded slice of a text file with line numbers.',
        args: '{"path": string, "startLine"?: number, "maxLines"?: number}',
        returns: '{"path": string, "startLine": number, "endLine": number, "lines": Array<{line, text}>, "truncated": boolean}',
        notes: 'Read-only. Use this for local agent-specific file inspection examples; built-in workspace.readFile is available too.',
        includeByDefault: true,
        keywords: ['starter', 'read', 'file', 'slice', 'lines']
      },
      createTool: context => ({
        async invoke(input) {
          if (typeof input.path !== 'string' || !input.path.trim()) {
            throw new Error('starter.readTextSlice requires a non-empty path.');
          }
          const { root, target } = resolveWorkspacePath(context, input.path);
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
            throw new Error(`File not found: ${toWorkspaceRelative(root, target)}`);
          }
          if (!isProbablyTextFile(target)) {
            throw new Error('starter.readTextSlice only reads recognized text file extensions.');
          }

          const maxBytes = clampInteger(context.maxBytesPerRead, DEFAULT_MAX_BYTES, 1024, 1024 * 1024);
          const maxLines = clampInteger(input.maxLines, 80, 1, 400);
          const requestedStart = clampInteger(input.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
          const read = readBoundedText(target, maxBytes);
          const allLines = read.text.split(/\r?\n/);
          const startIndex = Math.min(requestedStart - 1, Math.max(0, allLines.length - 1));
          const selected = allLines.slice(startIndex, startIndex + maxLines).map((line, index) => ({
            line: startIndex + index + 1,
            text: line
          }));

          return JSON.stringify({
            path: toWorkspaceRelative(root, target),
            startLine: selected.length ? selected[0].line : requestedStart,
            endLine: selected.length ? selected[selected.length - 1].line : requestedStart,
            lines: selected,
            truncated: read.truncated || startIndex + maxLines < allLines.length
          });
        }
      })
    },
    {
      contract: {
        name: 'starter.findTodos',
        description: 'Find TODO, FIXME, HACK, and NOTE comments in workspace text files.',
        args: '{"path"?: string, "maxResults"?: number, "maxFiles"?: number}',
        returns: '{"root": string, "matches": Array<{file, line, tag, text}>, "truncated": boolean}',
        notes: 'Read-only. Skips dependency and build output directories.',
        includeByDefault: true,
        keywords: ['starter', 'todo', 'fixme', 'notes', 'scan']
      },
      createTool: context => ({
        async invoke(input) {
          const { root, target } = resolveWorkspacePath(context, input.path);
          if (!fs.existsSync(target)) {
            throw new Error(`Path not found: ${toWorkspaceRelative(root, target)}`);
          }

          const maxResults = clampInteger(input.maxResults, 50, 1, 300);
          const maxFiles = clampInteger(input.maxFiles, 300, 1, 2000);
          const maxBytes = clampInteger(context.maxBytesPerRead, DEFAULT_MAX_BYTES, 1024, 1024 * 1024);
          const walked = walkTextFiles(root, target, maxFiles);
          const matches = [];
          let truncated = walked.truncated;
          const todoRegex = /\b(TODO|FIXME|HACK|NOTE)\b:?\s*(.*)/i;

          for (const file of walked.files) {
            const read = readBoundedText(file, maxBytes);
            const lines = read.text.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const match = lines[index].match(todoRegex);
              if (!match) {
                continue;
              }
              matches.push({
                file: toWorkspaceRelative(root, file),
                line: index + 1,
                tag: match[1].toUpperCase(),
                text: match[2].trim()
              });
              if (matches.length >= maxResults) {
                truncated = true;
                break;
              }
            }
            if (matches.length >= maxResults) {
              break;
            }
          }

          return JSON.stringify({
            root: toWorkspaceRelative(root, target),
            matches,
            truncated
          });
        }
      })
    }
  ]
};

module.exports = toolModule;
module.exports.toolModule = toolModule;
module.exports.default = toolModule;

