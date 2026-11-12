// Client adapters: detect an AI app, add or remove the agentbelt entry in its configuration, and
// say exactly what will change. Claude Code and Codex are changed through their own `mcp`
// commands; DeepSeek Harness has no such command, so a clearly marked block is added to its
// profile patch file. Each config file is backed up before it is changed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { backupsDir } from './paths.js';

export interface Entry {
  command: string;
  args: string[];
}

export interface ClientAdapter {
  id: 'deepseek' | 'claude-code' | 'codex' | 'cursor' | 'vscode' | 'claude-desktop' | 'lm-studio';
  label: string;
  /** The app gives MCP servers neither roots nor the project as cwd, so `--workspace` is required. */
  needsWorkspace?: boolean;
  detect(): boolean;
  /** The file that changes (backed up first), if any. */
  configFile(): string | null;
  isInstalled(): boolean;
  describe(entry: Entry): string;
  add(entry: Entry): void;
  remove(): void;
}

export function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const full = join(dir, name);
    if (dir && existsSync(full)) return full;
  }
  return null;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message}` };
  }
}

/** Copies a config file into the backups folder; returns the copy's path. */
export function backup(file: string | null, client: string): string | null {
  if (!file || !existsSync(file)) return null;
  mkdirSync(backupsDir(), { recursive: true });
  const copy = join(
    backupsDir(),
    `${client}-${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(file)}`,
  );
  copyFileSync(file, copy);
  return copy;
}

const BEGIN = '# >>> agentbelt (managed by `agentbelt setup`; removed by `agentbelt uninstall`)';
const END = '# <<< agentbelt';

export function deepseek(home = homedir()): ClientAdapter {
  const file = join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const strip = (text: string) =>
    text.replace(
      new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}[\\s\\S]*?${END}\\n?`),
      '\n',
    );
  return {
    id: 'deepseek',
    label: 'DeepSeek Harness',
    // Its MCP client advertises no roots and starts servers in ~/.dsh/profiles/desktop.
    needsWorkspace: true,
    detect: () => existsSync(join(home, '.dsh', 'profiles', 'desktop')),
    configFile: () => file,
    isInstalled: () => read().includes(BEGIN),
    describe: (e) =>
      `append an MCP client entry to ${file} (the app loads it without a restart):\n${block(e)}`,
    add(e) {
      const text = strip(read()).replace(/\n*$/, '\n');
      writeFileSync(file, `${text}${block(e)}`);
    },
    remove() {
      if (existsSync(file)) writeFileSync(file, strip(read()).replace(/\n*$/, '\n'));
    },
  };
  function block(e: Entry) {
    const q = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
    return [
      BEGIN,
      '- insert:',
      '    - id: agentbelt',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: agentbelt',
      '        transport: stdio',
      `        command: ${q(e.command)}`,
      `        args: [${e.args.map(q).join(', ')}]`,
      END,
      '',
    ].join('\n');
  }
}

export function claudeCode(home = homedir()): ClientAdapter {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    detect: () => !!onPath('claude'),
    configFile: () => join(home, '.claude.json'),
    isInstalled: () => run('claude', ['mcp', 'get', 'agentbelt']).ok,
    describe: (e) =>
      `run: claude mcp add-json --scope user agentbelt '${JSON.stringify({ type: 'stdio', ...e })}'`,
    add(e) {
      run('claude', ['mcp', 'remove', '--scope', 'user', 'agentbelt']);
      const r = run('claude', [
        'mcp',
        'add-json',
        '--scope',
        'user',
        'agentbelt',
        JSON.stringify({ type: 'stdio', ...e }),
      ]);
      if (!r.ok) throw new Error(`claude mcp add-json failed: ${r.out.trim()}`);
    },
    remove() {
      run('claude', ['mcp', 'remove', '--scope', 'user', 'agentbelt']);
    },
  };
}

export function codex(home = homedir()): ClientAdapter {
  return {
    id: 'codex',
    label: 'Codex',
    detect: () => !!onPath('codex'),
    configFile: () => join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
    isInstalled: () => run('codex', ['mcp', 'get', 'agentbelt']).ok,
    describe: (e) => `run: codex mcp add agentbelt -- ${[e.command, ...e.args].join(' ')}`,
    add(e) {
      run('codex', ['mcp', 'remove', 'agentbelt']);
      const r = run('codex', ['mcp', 'add', 'agentbelt', '--', e.command, ...e.args]);
      if (!r.ok) throw new Error(`codex mcp add failed: ${r.out.trim()}`);
    },
    remove() {
      run('codex', ['mcp', 'remove', 'agentbelt']);
    },
  };
}

// ------------------------------------------------ apps configured by a JSON file

/** Per-user application settings folder (macOS, Linux, Windows). */
export function appSupport(home = homedir()): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

interface JsonAppOptions {
  id: ClientAdapter['id'];
  label: string;
  file: string;
  /** The object holding server entries: `mcpServers` for most apps, `servers` for VS Code. */
  key: 'mcpServers' | 'servers';
  detect(): boolean;
  needsWorkspace?: boolean;
  /** What the app needs to pick the change up. */
  reload: string;
  shape(e: Entry): Record<string, unknown>;
}

/**
 * Adds or removes `agentbelt` under one key of a JSON config file, keeping everything else. A file
 * that is not plain JSON (for example with comments) is never rewritten: the user is told what to
 * add by hand instead.
 */
function jsonApp(o: JsonAppOptions): ClientAdapter {
  const read = (): Record<string, any> => {
    if (!existsSync(o.file)) return {};
    const text = readFileSync(o.file, 'utf8');
    if (!text.trim()) return {};
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // fall through
    }
    throw new Error(
      `${o.file} is not plain JSON (comments or trailing commas?), so it was not changed. ` +
        `Add this under "${o.key}" by hand: "agentbelt": ${JSON.stringify(o.shape({ command: '<agentbelt>', args: ['serve'] }))}`,
    );
  };
  const write = (value: Record<string, any>) => {
    mkdirSync(dirname(o.file), { recursive: true });
    writeFileSync(o.file, `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    id: o.id,
    label: o.label,
    needsWorkspace: o.needsWorkspace,
    detect: o.detect,
    configFile: () => o.file,
    isInstalled: () => {
      try {
        return !!read()[o.key]?.agentbelt;
      } catch {
        return false;
      }
    },
    describe: (e) =>
      `set "${o.key}.agentbelt" in ${o.file} to ${JSON.stringify(o.shape(e))} (${o.reload})`,
    add(e) {
      const value = read();
      const servers = value[o.key] && typeof value[o.key] === 'object' ? value[o.key] : {};
      value[o.key] = { ...servers, agentbelt: o.shape(e) };
      write(value);
    },
    remove() {
      if (!existsSync(o.file)) return;
      const value = read();
      if (!value[o.key]?.agentbelt) return;
      delete value[o.key].agentbelt;
      write(value);
    },
  };
}

/** Cursor: ~/.cursor/mcp.json. Cursor substitutes ${workspaceFolder}, so the open project is used. */
export function cursor(home = homedir()): ClientAdapter {
  return jsonApp({
    id: 'cursor',
    label: 'Cursor',
    file: join(home, '.cursor', 'mcp.json'),
    key: 'mcpServers',
    detect: () => existsSync(join(home, '.cursor')) || existsSync('/Applications/Cursor.app'),
    reload: 'Cursor picks it up in Settings → MCP',
    shape: (e) => ({
      command: e.command,
      args: e.args.includes('--workspace')
        ? e.args
        : [...e.args, '--workspace', '${workspaceFolder}'],
    }),
  });
}

/** VS Code (Copilot agent mode): user-level mcp.json. VS Code sends workspace folders as roots. */
export function vscode(home = homedir()): ClientAdapter {
  const dir = join(appSupport(home), 'Code', 'User');
  return jsonApp({
    id: 'vscode',
    label: 'VS Code',
    file: join(dir, 'mcp.json'),
    key: 'servers',
    detect: () => existsSync(dir),
    reload: 'VS Code reloads it automatically',
    shape: (e) => ({ type: 'stdio', command: e.command, args: e.args }),
  });
}

/** Claude Desktop: claude_desktop_config.json. It gives no project, so --workspace is required. */
export function claudeDesktop(home = homedir()): ClientAdapter {
  const dir = join(appSupport(home), 'Claude');
  return jsonApp({
    id: 'claude-desktop',
    label: 'Claude Desktop',
    file: join(dir, 'claude_desktop_config.json'),
    key: 'mcpServers',
    needsWorkspace: true,
    detect: () => existsSync(dir),
    reload: 'restart Claude Desktop to load it',
    shape: (e) => ({ command: e.command, args: e.args }),
  });
}

/** LM Studio: ~/.lmstudio/mcp.json. It gives no project, so --workspace is required. */
export function lmStudio(home = homedir()): ClientAdapter {
  return jsonApp({
    id: 'lm-studio',
    label: 'LM Studio',
    file: join(home, '.lmstudio', 'mcp.json'),
    key: 'mcpServers',
    needsWorkspace: true,
    detect: () => existsSync(join(home, '.lmstudio')),
    reload: 'LM Studio reloads it automatically',
    shape: (e) => ({ command: e.command, args: e.args }),
  });
}

export const allAdapters = (home = homedir()): ClientAdapter[] => [
  deepseek(home),
  claudeCode(home),
  codex(home),
  cursor(home),
  vscode(home),
  claudeDesktop(home),
  lmStudio(home),
];
