// The MCP server: registers every enabled plugin's tools (as <plugin>_<tool>) and every skill (as
// an MCP prompt) on the official SDK, and runs each call through the broker and the audit log.
// The server is bound to one workspace: --workspace, else the client's first root, else the
// current directory's git repository. It refuses to work on the home directory or /.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { AuditLog, type Isolation } from './audit.js';
import { BrokerDenied, createContext } from './broker.js';
import { toolId, type Plugin, type ToolDefinition, type ToolResult } from './plugin.js';
import { redact } from './redact.js';

export interface ServerOptions {
  version: string;
  plugins: Plugin[];
  /** Fixed workspace; otherwise resolved from the client's roots or the current directory. */
  workspace?: string;
  /** Directories holding <skill>/SKILL.md, exposed as prompts. */
  skillsDirs?: string[];
  /** How plugin commands are isolated (shown in the audit log and status). */
  isolation?: Isolation;
  /** Lines shown by agentbelt_status, e.g. third-party plugins that were refused and why. */
  notices?: string[];
}

/** The git repository containing `dir`, or `dir` itself. */
export function projectRoot(dir: string): string {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(dir);
    current = parent;
  }
}

export function checkWorkspace(dir: string): string | null {
  const full = resolve(dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) return `workspace ${full} does not exist`;
  const home = resolve(homedir());
  if (full === home || full === '/')
    return `refusing to use ${full} as the workspace; open a project folder (or pass --workspace)`;
  // An app's own settings folder (e.g. ~/.dsh/profiles/desktop, where DeepSeek Harness starts
  // servers) is never a project, even though it is neither / nor home.
  const inHome = full.startsWith(home + sep) ? full.slice(home.length + 1) : null;
  if (inHome && (inHome.startsWith('.') || inHome === 'Library' || inHome.startsWith(`Library${sep}`)))
    return `refusing to use ${full} as the workspace: it is an app settings folder, not a project (pass --workspace)`;
  return null;
}

interface Skill {
  name: string;
  description: string;
  body: string;
}

/** Reads <dir>/<name>/SKILL.md files (Agent Skills format: YAML frontmatter + instructions). */
export function loadSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry, 'SKILL.md');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      if (!m) continue;
      const field = (k: string) =>
        new RegExp(`^${k}:\\s*(.+)$`, 'm')
          .exec(m[1])?.[1]
          .trim()
          .replace(/^["']|["']$/g, '');
      const name = field('name');
      if (name && /^[a-z0-9-]{1,64}$/.test(name))
        skills.push({ name, description: field('description') ?? '', body: m[2].trim() });
    }
  }
  return skills;
}

export function createAgentbeltServer(options: ServerOptions) {
  const server = new McpServer(
    { name: 'agentbelt', version: options.version },
    {
      instructions:
        'agentbelt tools work on one project (the workspace). Git tools never push; commits go ' +
        'to agentbelt/* task branches. Workflow approval gates are decided by the user in the ' +
        'agentbelt CLI, not through these tools. Use the agentbelt_status tool to see the ' +
        'workspace and the installed plugins.',
    },
  );
  const client = () => server.server.getClientVersion()?.name ?? 'unknown';
  const tools = new Map<string, { plugin: Plugin; tool: ToolDefinition }>();
  let workspace: string | null = options.workspace ? resolve(options.workspace) : null;
  let audit: AuditLog | null = null;

  async function resolveWorkspace(): Promise<string> {
    if (workspace) {
      const problem = checkWorkspace(workspace);
      if (problem) throw new Error(problem);
      return (workspace = realpathSync(workspace));
    }
    let dir = process.cwd();
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
        const first = roots.find((r) => r.uri.startsWith('file://'));
        if (first) dir = fileURLToPath(first.uri);
      } catch {
        // Clients may advertise roots but not answer; fall back to the current directory.
      }
    }
    const root = projectRoot(dir);
    const problem = checkWorkspace(root);
    if (problem) throw new Error(problem);
    return (workspace = realpathSync(root));
  }

  async function invoke(
    id: string,
    args: Record<string, unknown>,
    via?: string,
  ): Promise<ToolResult> {
    const entry = tools.get(id);
    if (!entry) return { text: `unknown tool ${id}`, isError: true };
    const ws = await resolveWorkspace();
    audit ??= new AuditLog(ws, client);
    const checked = await entry.tool.input['~standard'].validate(args);
    if (checked.issues)
      return {
        text: `invalid arguments: ${checked.issues.map((i: { message: string; path?: readonly unknown[] }) => `${(i.path ?? []).join('.')} ${i.message}`.trim()).join('; ')}`,
        isError: true,
      };
    const parsed = { data: checked.value };
    const started = Date.now();
    let result: ToolResult;
    try {
      const ctx = createContext(entry.plugin, {
        workspace: ws,
        audit,
        isolation: options.isolation,
        callTool: (target, a, from) => invoke(target, a, from),
        listTools: () => [...tools.keys()],
      });
      result = await entry.tool.run(parsed.data, ctx);
    } catch (error) {
      result = {
        text: error instanceof BrokerDenied ? error.message : `error: ${(error as Error).message}`,
        isError: true,
      };
    }
    audit.write({
      kind: 'tool',
      plugin: entry.plugin.name,
      tool: id,
      detail: `${via ? `via ${via}: ` : ''}${JSON.stringify(args)} → ${result.isError ? 'error' : 'ok'}`,
      ok: !result.isError,
      isolation: entry.plugin.isolation ?? 'policy-only',
      ms: Date.now() - started,
    });
    return { ...result, text: redact(result.text) };
  }

  for (const plugin of options.plugins)
    for (const tool of plugin.tools) {
      const id = toolId(plugin.name, tool.name);
      tools.set(id, { plugin, tool });
      server.registerTool(
        id,
        {
          description: tool.description,
          inputSchema: tool.input,
          annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive },
        },
        async (args: Record<string, unknown>) => {
          const r = await invoke(id, args ?? {});
          return { content: [{ type: 'text' as const, text: r.text }], isError: !!r.isError };
        },
      );
    }

  server.registerTool(
    'agentbelt_status',
    {
      description: 'Shows the agentbelt version, the workspace, the installed plugins and tools.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      let ws: string;
      try {
        ws = await resolveWorkspace();
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: (error as Error).message }],
          isError: true,
        };
      }
      const lines = [
        `agentbelt ${options.version}`,
        `workspace: ${ws}`,
        `client: ${client()}`,
        `command isolation: ${options.isolation ?? 'policy-only'} (policy-only = permission and command checks, no OS sandbox)`,
        'plugins:',
        ...options.plugins.map(
          (p) =>
            `  ${p.name} ${p.version}${p.isolation ? ` (third-party, ${p.isolation})` : ''}: ${p.tools.map((t) => toolId(p.name, t.name)).join(', ')}`,
        ),
        ...(options.notices ?? []).map((n) => `notice: ${n}`),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  for (const skill of loadSkills(options.skillsDirs ?? []))
    server.registerPrompt(skill.name, { description: skill.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill.body } }],
    }));

  /** A plugin's broker context (for the CLI, e.g. continuing a workflow after approval). */
  async function contextFor(name: string) {
    const plugin = options.plugins.find((p) => p.name === name);
    if (!plugin) throw new Error(`plugin ${name} is not installed`);
    const ws = await resolveWorkspace();
    audit ??= new AuditLog(ws, client);
    return createContext(plugin, {
      workspace: ws,
      audit,
      isolation: options.isolation,
      callTool: (target, a, from) => invoke(target, a, from),
      listTools: () => [...tools.keys()],
    });
  }

  return {
    server,
    contextFor,
    /** Runs a tool directly (used by the CLI and tests); same checks and audit as MCP calls. */
    invoke,
    toolIds: () => [...tools.keys()],
  };
}

/** Serves over stdin/stdout until the client disconnects. */
export async function serveStdio(options: ServerOptions): Promise<void> {
  const { server } = createAgentbeltServer(options);
  await server.connect(new StdioServerTransport());
}
