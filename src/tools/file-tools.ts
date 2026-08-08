/**
 * File and search tools.
 *
 * Descriptions matter as much as behaviour here: they are the only instructions
 * the model gets about *when* to reach for each tool. They steer it toward
 * search-then-targeted-read instead of reading whole directories, and toward
 * edit_file instead of rewriting files wholesale.
 */
import { audit } from '../logger.js';
import { registry } from '../workspace/registry.js';
import { createDir, deletePath, editFile, listDir, movePath, readFile, statPath, withLineNumbers, writeFile, type EditSpec } from '../fs/ops.js';
import { findFiles, searchCode } from '../fs/search.js';
import { block, join, kv, type Args, type ToolDef } from './types.js';
import { BridgeError } from '../errors.js';

function ws(args: Args) {
  return registry().require(args.optStr('workspace'));
}

const workspaceParam = {
  workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
};

export const fileTools: ToolDef[] = [
  {
    name: 'list_dir',
    description:
      'List files and directories. Use for orientation in an unfamiliar area of the repo. Build outputs, node_modules and .git are skipped automatically. Prefer search_code when you are looking for something specific.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        path: { type: 'string', description: 'Directory relative to the workspace root. Default: "."' },
        depth: { type: 'number', description: 'Levels to descend, 1-6. Default 1.' },
        include_hidden: { type: 'boolean', description: 'Include dot-files. Default false.' },
        limit: { type: 'number', description: 'Max entries. Default 500.' },
      },
    },
    handler: async (args) => {
      const w = ws(args);
      const { entries, truncated } = listDir(w.root, args.str('path', '.'), {
        depth: args.optNum('depth'),
        includeHidden: args.bool('include_hidden', false),
        limit: args.optNum('limit'),
      });
      const lines = entries.map((e) =>
        e.type === 'dir' ? `${e.path}/` : `${e.path}${e.size !== undefined ? `  (${formatBytes(e.size)})` : ''}`,
      );
      return join(
        block(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} under ${args.str('path', '.')}`, lines),
        truncated ? 'Result truncated — narrow the path or lower the depth.' : '',
      );
    },
  },

  {
    name: 'read_file',
    description:
      'Read a file as text. Returns exact file content (no line numbers by default) so it can be copied verbatim into edit_file anchors. For large files pass start_line/end_line, or use search_code first to find the region worth reading. Credential files (.env, keys, cloud config) are never returned.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        start_line: { type: 'number', description: '1-based first line to return.' },
        end_line: { type: 'number', description: '1-based last line to return.' },
        line_numbers: {
          type: 'boolean',
          description: 'Prefix each line with its number. Navigation aid only — do NOT copy numbered text into edit_file. Default false.',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const w = ws(args);
      const result = readFile(w.root, args.str('path'), {
        startLine: args.optNum('start_line'),
        endLine: args.optNum('end_line'),
      });
      const body = args.bool('line_numbers', false)
        ? withLineNumbers(result.content, result.startLine)
        : result.content;
      const header =
        `${result.path} — lines ${result.startLine}-${result.endLine} of ${result.totalLines}` +
        (result.truncated ? ' (partial)' : '') +
        `, ${formatBytes(result.bytes)}`;
      return `${header}\n${'─'.repeat(Math.min(header.length, 80))}\n${body}`;
    },
  },

  {
    name: 'search_code',
    description:
      'Search file contents across the repository and return matching lines with file:line locations. This is the primary way to find code — far cheaper than reading files. Supports literal or regex patterns, glob filters, and surrounding context lines. Respects .gitignore.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        pattern: { type: 'string', description: 'Text to find, or a regular expression when regex=true.' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false (literal).' },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only search files matching these globs, e.g. ["**/*.java", "src/**/*.ts"].',
        },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Skip files matching these globs.' },
        path: { type: 'string', description: 'Restrict the search to this subdirectory.' },
        context_lines: { type: 'number', description: 'Lines of context around each match, 0-10. Default 0.' },
        max_results: { type: 'number', description: 'Default 100, max 1000.' },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      const w = ws(args);
      const res = await searchCode(w.root, {
        pattern: args.str('pattern'),
        regex: args.bool('regex', false),
        caseSensitive: args.bool('case_sensitive', false),
        include: args.strArray('include'),
        exclude: args.strArray('exclude'),
        ...(args.optStr('path') !== undefined ? { subPath: args.str('path') } : {}),
        contextLines: args.optNum('context_lines') ?? 0,
        maxResults: args.optNum('max_results') ?? 100,
      });

      if (res.matches.length === 0) {
        return `No matches for "${args.str('pattern')}" (${res.filesScanned} files scanned, ${res.elapsedMs}ms).`;
      }

      const lines: string[] = [];
      let lastPath = '';
      for (const m of res.matches) {
        if (m.path !== lastPath) {
          lines.push('');
          lines.push(`${m.path}`);
          lastPath = m.path;
        }
        for (const b of m.before ?? []) lines.push(`      │ ${b}`);
        lines.push(`  ${String(m.line).padStart(5)}│ ${m.text}`);
        for (const a of m.after ?? []) lines.push(`      │ ${a}`);
      }

      return join(
        `${res.matches.length} match(es) in ${res.filesWithMatches} file(s) — ${res.engine}, ${res.elapsedMs}ms` +
          (res.truncated ? ' [truncated: raise max_results or narrow the pattern]' : ''),
        lines.join('\n').trim(),
      );
    },
  },

  {
    name: 'find_files',
    description:
      'Find files by name or glob pattern (e.g. "**/*Service.java", "**/test_*.py"). Use when you know roughly what a file is called but not where it lives.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns. A pattern without "/" also matches file names anywhere in the tree.',
        },
        path: { type: 'string', description: 'Restrict to this subdirectory.' },
        max_results: { type: 'number', description: 'Default 200.' },
      },
      required: ['patterns'],
    },
    handler: async (args) => {
      const w = ws(args);
      const patterns = args.strArray('patterns');
      if (patterns.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'patterns must not be empty');
      const { files, truncated } = findFiles(w.root, patterns, {
        ...(args.optStr('path') !== undefined ? { subPath: args.str('path') } : {}),
        maxResults: args.optNum('max_results') ?? 200,
      });
      if (files.length === 0) return `No files match ${patterns.join(', ')}.`;
      return join(
        `${files.length} file(s)${truncated ? ' [truncated]' : ''}`,
        files.join('\n'),
      );
    },
  },

  {
    name: 'write_file',
    description:
      'Create a new file, or replace / append to an existing one. Use this for NEW files. To change part of an existing file use edit_file instead — it is safer and much cheaper than resending the whole file.',
    capability: 'write',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        path: { type: 'string', description: 'File path relative to the workspace root. Parent directories are created.' },
        content: { type: 'string', description: 'Full file content (or the text to append).' },
        mode: {
          type: 'string',
          enum: ['create', 'overwrite', 'append'],
          description: 'create (default, fails if the file exists), overwrite, or append.',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      const w = ws(args);
      const mode = args.str('mode', 'create') as 'create' | 'overwrite' | 'append';
      if (!['create', 'overwrite', 'append'].includes(mode)) {
        throw new BridgeError('INVALID_ARGUMENT', `mode must be create, overwrite or append.`);
      }
      const res = writeFile(w.root, args.str('path'), args.str('content', ''), mode);
      registry().recordFile(w.id, res.path, res.action === 'created' ? 'created' : 'modified');
      audit({ action: 'write_file', workspace: w.alias, target: res.path, outcome: 'ok', detail: { mode } });
      return `${res.action} ${res.path} — ${res.lines} lines, ${formatBytes(res.bytes)}`;
    },
  },

  {
    name: 'edit_file',
    description:
      'Make targeted edits to an existing file by replacing exact text. Each edit\'s old_string must appear exactly once (include surrounding lines to disambiguate) unless replace_all is set. All edits are applied atomically — if any anchor fails to match, the file is left untouched and you are told why. This is the preferred way to modify code.',
    capability: 'write',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        path: { type: 'string', description: 'File to edit, relative to the workspace root.' },
        edits: {
          type: 'array',
          description: 'Edits applied in order.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to replace, copied verbatim from read_file output.' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    handler: async (args) => {
      const w = ws(args);
      const specs: EditSpec[] = args.objArray('edits').map((e, i) => {
        if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
          throw new BridgeError('INVALID_ARGUMENT', `edits[${i}] needs string old_string and new_string.`);
        }
        return {
          oldString: e.old_string,
          newString: e.new_string,
          ...(e.replace_all === true ? { replaceAll: true } : {}),
        };
      });

      const res = editFile(w.root, args.str('path'), specs);
      registry().recordFile(w.id, res.path, 'modified');
      audit({ action: 'edit_file', workspace: w.alias, target: res.path, outcome: 'ok', detail: { edits: res.editsApplied } });
      return join(
        `edited ${res.path} — ${res.editsApplied} edit(s), ${res.replacements} replacement(s), ${res.linesBefore} → ${res.linesAfter} lines`,
        res.preview,
      );
    },
  },

  {
    name: 'move_path',
    description: 'Move or rename a file or directory inside the workspace.',
    capability: 'write',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        from: { type: 'string', description: 'Existing path.' },
        to: { type: 'string', description: 'Destination path.' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it exists. Default false.' },
      },
      required: ['from', 'to'],
    },
    handler: async (args) => {
      const w = ws(args);
      const res = movePath(w.root, args.str('from'), args.str('to'), args.bool('overwrite', false));
      registry().recordFile(w.id, res.to, 'moved');
      audit({ action: 'move_path', workspace: w.alias, target: `${res.from} → ${res.to}`, outcome: 'ok' });
      return `moved ${res.from} → ${res.to}`;
    },
  },

  {
    name: 'delete_path',
    description:
      'Delete a file, or a directory tree with recursive=true. Deleting the workspace root is refused. Prefer deleting specific files over directories.',
    capability: 'write',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        path: { type: 'string', description: 'Path to delete.' },
        recursive: { type: 'boolean', description: 'Required to delete a directory. Default false.' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const w = ws(args);
      const res = deletePath(w.root, args.str('path'), args.bool('recursive', false));
      registry().recordFile(w.id, res.path, 'deleted');
      audit({ action: 'delete_path', workspace: w.alias, target: res.path, outcome: 'ok', detail: { kind: res.kind } });
      return `deleted ${res.kind} ${res.path}${res.kind === 'dir' ? ` (${res.entries} entries)` : ''}`;
    },
  },

  {
    name: 'create_dir',
    description: 'Create a directory (including parents). write_file already creates parent directories, so this is only needed for empty directories.',
    capability: 'write',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: { ...workspaceParam, path: { type: 'string', description: 'Directory to create.' } },
      required: ['path'],
    },
    handler: async (args) => {
      const w = ws(args);
      const res = createDir(w.root, args.str('path'));
      return res.created ? `created directory ${res.path}` : `directory ${res.path} already exists`;
    },
  },

  {
    name: 'file_info',
    description: 'Check whether a path exists and get its size and modification time, without reading it.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceParam, path: { type: 'string', description: 'Path to inspect.' } },
      required: ['path'],
    },
    handler: async (args) => {
      const w = ws(args);
      const info = statPath(w.root, args.str('path'));
      if (!info.exists) return `${info.path} does not exist`;
      return block(info.path, kv({ type: info.type, size: info.size !== undefined ? formatBytes(info.size) : undefined, modified: info.modified }));
    },
  },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
