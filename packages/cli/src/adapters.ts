// Client adapters: detect an AI app, add or remove the agentbelt entry in its configuration, and
// say exactly what will change. Claude Code and Codex are changed through their own `mcp`
// commands; DeepSeek Harness has no such command, so a clearly marked block is added to its
// profile patch file. Each config file is backed up before it is changed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { backupsDir } from './paths.js';

export interface Entry {
  command: string;
  args: string[];
}

export interface ClientAdapter {
  id: 'deepseek' | 'claude-code' | 'codex';
  label: string;
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

export const allAdapters = (home = homedir()): ClientAdapter[] => [
  deepseek(home),
  claudeCode(home),
  codex(home),
];
