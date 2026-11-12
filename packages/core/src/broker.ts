// The broker builds each plugin's context. Every action is checked when it happens:
//   exec       → the program must be in the plugin's permissions AND pass the core command policy
//   read/write → the permission must be granted AND the path must stay inside the workspace
//                (no .git, no .agentbelt, no symlink escapes)
//   callTool   → the permission must be granted; the called tool runs with its own plugin's rules
// Denials throw a BrokerDenied error (shown to the model as a tool error) and are audited.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AuditLog, Isolation } from './audit.js';
import { childEnv } from './env.js';
import type { Plugin, PluginContext, ToolResult } from './plugin.js';
import { checkCommand, checkPath, DEFAULT_COMMAND_TIMEOUT_MS, runCommand } from './policy.js';
import { redact } from './redact.js';

export class BrokerDenied extends Error {}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export interface BrokerDeps {
  workspace: string;
  audit: AuditLog;
  /** Runs another plugin's tool by its client-facing id. */
  callTool: (id: string, args: Record<string, unknown>, via: string) => Promise<ToolResult>;
  listTools: () => string[];
  isolation?: Isolation;
}

export function createContext(plugin: Plugin, deps: BrokerDeps): PluginContext {
  const { audit } = deps;
  // Path checks compare real (symlink-resolved) paths, so the workspace must be one too.
  const workspace = realpathSync(deps.workspace);
  const isolation = deps.isolation ?? 'policy-only';
  const perms = plugin.permissions;
  const deny = (detail: string): never => {
    audit.write({ kind: 'denied', plugin: plugin.name, detail, ok: false });
    throw new BrokerDenied(`denied: ${detail}`);
  };
  const filePath = (path: string, write: boolean): string => {
    if (write ? !perms.write : !perms.read)
      deny(`${plugin.name} has no ${write ? 'write' : 'read'} permission (${path})`);
    const reason = checkPath(workspace, workspace, path);
    if (reason) deny(reason);
    return resolve(workspace, path);
  };
  const stateDir = join(workspace, '.agentbelt', 'state', plugin.name);
  const stateFile = (key: string) => {
    if (!KEY.test(key)) throw new Error(`invalid state key "${key}"`);
    return join(stateDir, `${key}.json`);
  };

  return {
    workspace,
    async exec(program, args, options = {}) {
      if (!(perms.exec ?? []).includes(program))
        deny(
          `${plugin.name} may not run ${program} (allowed: ${(perms.exec ?? []).join(', ') || 'none'})`,
        );
      const cwd = resolve(workspace, options.cwd ?? '.');
      const reason = checkCommand(workspace, cwd, program, args);
      if (reason) deny(`${program} ${args.join(' ')}: ${reason}`);
      const result = await runCommand(
        program,
        args,
        cwd,
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        childEnv(),
      );
      audit.write({
        kind: 'exec',
        plugin: plugin.name,
        detail: `${program} ${args.join(' ')} → exit ${result.exitCode}`,
        ok: result.exitCode === 0,
        isolation,
        ms: result.durationMs,
      });
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    },
    async readFile(path) {
      const full = filePath(path, false);
      return readFileSync(full, 'utf8');
    },
    async listFiles(dir) {
      const full = filePath(dir, false);
      try {
        return readdirSync(full).sort();
      } catch {
        return [];
      }
    },
    async writeFile(path, text) {
      const full = filePath(path, true);
      mkdirSync(dirname(full), { recursive: true });
      const tmp = `${full}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, full);
      audit.write({
        kind: 'file',
        plugin: plugin.name,
        detail: `wrote ${path}`,
        ok: true,
        isolation,
      });
    },
    state: {
      get<T>(key: string): T | undefined {
        try {
          return JSON.parse(readFileSync(stateFile(key), 'utf8')) as T;
        } catch {
          return undefined;
        }
      },
      set(key: string, value: unknown) {
        const file = stateFile(key);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
        renameSync(`${file}.tmp`, file);
      },
      list() {
        try {
          return readdirSync(stateDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort();
        } catch {
          return [];
        }
      },
    },
    async callTool(id, args) {
      if (!perms.callTools) deny(`${plugin.name} may not call other tools (${id})`);
      return deps.callTool(id, args, plugin.name);
    },
    listTools: deps.listTools,
  };
}
