// Parent side of untrusted plugins: installs them without running any package scripts, records a
// grant pinned to the exact files that were reviewed, and runs them only inside the OS sandbox.
// No sandbox backend → refused. Files changed since the grant → refused until granted again.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { Permissions, Plugin, PluginContext, ToolDefinition, ToolResult } from './plugin.js';
import { sandboxBackend } from './sandbox.js';

export interface Grant {
  name: string;
  version: string;
  /** sha256 over every file of the installed package, as reviewed. */
  hash: string;
  permissions: Permissions;
  dir: string;
  entry: string;
  grantedAt: string;
}

export interface ExternalManifest {
  name: string;
  version: string;
  entry: string;
  permissions: Permissions;
  dir: string;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** sha256 over all files (path + content) under `dir`. */
export function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(relative(dir, full));
        h.update('\0');
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

export class GrantStore {
  constructor(private readonly file: string) {}
  all(): Grant[] {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }
  save(grants: Grant[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(grants, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
  put(g: Grant) {
    this.save([...this.all().filter((x) => x.name !== g.name), g]);
  }
  remove(name: string) {
    this.save(this.all().filter((x) => x.name !== name));
  }
}

/**
 * Downloads a plugin package into a staging folder with lifecycle scripts disabled and reads its
 * static manifest (package.json "agentbelt" field). No plugin code runs here.
 */
export function stagePlugin(spec: string, pluginsDir: string, npm = 'npm'): ExternalManifest {
  if (!sandboxBackend())
    throw new Error(
      'third-party plugins need OS isolation, and no sandbox backend is available on this system; refusing to install (agentbelt never runs untrusted plugins without a sandbox)',
    );
  mkdirSync(pluginsDir, { recursive: true });
  const staging = mkdtempSync(join(pluginsDir, '.staging-'));
  writeFileSync(join(staging, 'package.json'), '{ "private": true }\n');
  try {
    execFileSync(
      npm,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        '--prefix',
        staging,
        spec,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const deps = Object.keys(
      JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')).dependencies ?? {},
    );
    if (deps.length !== 1) throw new Error('could not identify the installed package');
    const dir = join(staging, 'node_modules', deps[0]);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const meta = pkg.agentbelt;
    if (!meta?.plugin || !meta?.name)
      throw new Error(
        `${deps[0]} is not an agentbelt plugin (no "agentbelt" field in package.json)`,
      );
    if (!NAME.test(meta.name)) throw new Error(`invalid plugin name ${meta.name}`);
    const entry = join(dir, meta.plugin);
    if (!entry.startsWith(dir) || !existsSync(entry))
      throw new Error('plugin entry file not found');
    return {
      name: meta.name,
      version: pkg.version,
      entry,
      permissions: meta.permissions ?? {},
      dir: staging,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Moves a reviewed staging folder into place and records the grant. */
export function grantPlugin(m: ExternalManifest, pluginsDir: string, grants: GrantStore): Grant {
  const target = join(pluginsDir, m.name);
  rmSync(target, { recursive: true, force: true });
  renameSync(m.dir, target);
  const entry = join(target, relative(m.dir, m.entry));
  const grant: Grant = {
    name: m.name,
    version: m.version,
    hash: hashDir(target),
    permissions: m.permissions,
    dir: target,
    entry,
    grantedAt: new Date().toISOString(),
  };
  grants.put(grant);
  return grant;
}

const hostPath = () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return [join(here, 'plugin-host.js'), join(here, 'plugin-host.ts')].find(existsSync)!;
};

/** Why a granted plugin can't be loaded right now, or null if it can. */
export function refusal(g: Grant): string | null {
  if (!sandboxBackend()) return 'no OS sandbox is available on this system (fail closed)';
  if (!existsSync(g.entry)) return 'its files are missing; reinstall it';
  if (hashDir(g.dir) !== g.hash)
    return 'its files changed since you granted it; run `agentbelt plugin add` again';
  return null;
}

/** Starts a granted plugin inside the sandbox and returns it as a normal Plugin. */
export async function loadExternal(g: Grant, timeoutMs = 15_000): Promise<Plugin> {
  const why = refusal(g);
  if (why) throw new Error(`plugin ${g.name} refused: ${why}`);
  const host = hostPath();
  // Readable: the plugin's own folder and the host's package (code only; no user files).
  const child: ChildProcess = sandboxBackend()!.spawnNode(
    [host, g.entry],
    [g.dir, dirname(dirname(host))],
  );
  let stderr = '';
  child.stderr!.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
  const lines = createInterface({ input: child.stdout! });
  const waiting = new Map<number, (m: any) => void>();
  let manifest: any;
  const ctxFor = new Map<number, PluginContext>();
  let nextCall = 1;
  const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`);

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`plugin ${g.name} did not start: ${stderr.trim()}`)),
      timeoutMs,
    );
    child.once('exit', (code) =>
      reject(new Error(`plugin ${g.name} exited (${code}): ${stderr.trim()}`)),
    );
    lines.on('line', async (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.t === 'manifest') {
        manifest = m;
        clearTimeout(timer);
        resolve();
      } else if (m.t === 'result') waiting.get(m.id)?.(m);
      else if (m.t === 'ctx') {
        // The plugin asks to act: run it through this call's broker context.
        const ctx = ctxFor.get(m.call);
        try {
          if (!ctx) throw new Error('no active call');
          const p = m.params ?? {};
          const ops: Record<string, () => unknown> = {
            exec: () => ctx.exec(p.program, p.args, p.options),
            readFile: () => ctx.readFile(p.path),
            writeFile: () => ctx.writeFile(p.path, p.text),
            listFiles: () => ctx.listFiles(p.dir),
            callTool: () => ctx.callTool(p.name, p.args),
            listTools: () => ctx.listTools(),
            'state.get': () => ctx.state.get(p.key),
            'state.set': () => ctx.state.set(p.key, p.value),
            'state.list': () => ctx.state.list(),
          };
          if (!Object.hasOwn(ops, m.op)) throw new Error(`unknown operation ${m.op}`);
          send({ t: 'ctx-result', id: m.id, value: (await ops[m.op]()) ?? null });
        } catch (error) {
          send({ t: 'ctx-result', id: m.id, error: (error as Error).message });
        }
      }
    });
  });
  await ready;
  if (manifest.name !== g.name) {
    child.kill();
    throw new Error(`plugin declares name ${manifest.name}, granted as ${g.name}`);
  }

  const tools: ToolDefinition<any>[] = (manifest.tools ?? []).map((t: any) => ({
    name: t.name,
    description: `${t.description} [third-party plugin ${g.name}, runs in an OS sandbox]`,
    input: fromJsonSchema(t.inputSchema),
    readOnly: !!t.readOnly,
    run: (args: unknown, ctx: PluginContext) =>
      new Promise<ToolResult>((resolve) => {
        const id = nextCall++;
        ctxFor.set(id, ctx);
        waiting.set(id, (m) => {
          waiting.delete(id);
          ctxFor.delete(id);
          resolve(
            m.error
              ? { text: `error: ${m.error}`, isError: true }
              : {
                  text: String(m.result?.text ?? ''),
                  data: m.result?.data,
                  isError: !!m.result?.isError,
                },
          );
        });
        send({ t: 'call', id, tool: t.name, args });
      }),
  }));
  return {
    name: g.name,
    version: g.version,
    description: manifest.description ?? '',
    permissions: g.permissions, // the grant, never what the running code claims
    tools,
    isolation: 'os-sandbox',
    close: () => child.kill(),
  };
}
