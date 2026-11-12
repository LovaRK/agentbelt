// The plugin SDK. A plugin is a name, a version, the permissions it needs and a list of tools.
// Tools never touch the system directly: everything goes through the context (ctx) the broker
// gives them, which checks each action against the plugin's permissions when it happens.
import type * as z from 'zod';
import type { ChatRequest, ChatResult } from './model.js';
import type { CommandResult } from './policy.js';

export interface Permissions {
  /** Programs the plugin may run. Each command still has to pass the core command policy. */
  exec?: string[];
  /** Read files inside the workspace. */
  read?: boolean;
  /** Write files inside the workspace (never inside .git or .agentbelt). */
  write?: boolean;
  /** Call other plugins' tools; each runs with its own plugin's permissions. */
  callTools?: boolean;
  /**
   * Chat with the model the user configured with `agentbelt agent setup`. The endpoint and API
   * key stay in the core; the plugin only sends messages and gets replies.
   */
  model?: boolean;
}

export interface ToolResult {
  /** What the model reads. */
  text: string;
  /** Structured output, also available to workflow steps as ${steps.<id>.<field>}. */
  data?: Record<string, unknown>;
  isError?: boolean;
}

export interface ExecOptions {
  /** Working directory, relative to the workspace (default: the workspace). */
  cwd?: string;
  timeoutMs?: number;
}

export interface PluginContext {
  /** Absolute path of the project the server is bound to. */
  readonly workspace: string;
  exec(program: string, args: string[], options?: ExecOptions): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** Names in a workspace directory ([] if it doesn't exist). Needs read permission. */
  listFiles(dir: string): Promise<string[]>;
  /** Small JSON documents private to this plugin, stored in <workspace>/.agentbelt/state. */
  state: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    list(): string[];
  };
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Ids of all installed tools, e.g. git_status. */
  listTools(): string[];
  /** The configured model (needs the model permission), or null if none is configured. */
  model: { name: string; endpoint: string; chat(request: ChatRequest): Promise<ChatResult> } | null;
}

/** Any Standard Schema (zod objects, or JSON Schema wrapped by the MCP SDK). */
export type InputSchema = z.ZodObject | { '~standard': { validate: (v: unknown) => any } };

export interface ToolDefinition<S extends InputSchema = z.ZodObject> {
  /** Short name; exposed to clients as <plugin>_<name>. */
  name: string;
  description: string;
  input: S;
  /** Hints for clients' own approval prompts. */
  readOnly?: boolean;
  destructive?: boolean;
  run(args: S extends z.ZodObject ? z.infer<S> : any, ctx: PluginContext): Promise<ToolResult>;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  permissions: Permissions;
  tools: ToolDefinition<any>[];
  /** Set by the host: 'os-sandbox' for third-party plugins running in the sandbox. */
  isolation?: 'os-sandbox';
  /** Set by the host for out-of-process plugins. */
  close?: () => void;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const TOOL = /^[a-z][a-z0-9_]{0,40}$/;

/** Checks a plugin definition and returns it unchanged. */
export function definePlugin(plugin: Plugin): Plugin {
  if (!NAME.test(plugin.name)) throw new Error(`invalid plugin name "${plugin.name}"`);
  const seen = new Set<string>();
  for (const tool of plugin.tools) {
    if (!TOOL.test(tool.name)) throw new Error(`${plugin.name}: invalid tool name "${tool.name}"`);
    if (seen.has(tool.name)) throw new Error(`${plugin.name}: duplicate tool "${tool.name}"`);
    seen.add(tool.name);
  }
  return plugin;
}

/** The name clients see. */
export const toolId = (plugin: string, tool: string) => `${plugin.replace(/-/g, '_')}_${tool}`;

/** Convenience helpers for tool results. */
export const ok = (text: string, data?: Record<string, unknown>): ToolResult => ({ text, data });
export const fail = (text: string, data?: Record<string, unknown>): ToolResult => ({
  text,
  data,
  isError: true,
});
