// The model behind the optional coding-agent plugin. agentbelt itself needs no model (MCP clients
// bring their own); this is only used when the user ran `agentbelt agent setup`.
//
// Security:
// - The endpoint and model are chosen by the user at setup and stored in agentbelt's own config
//   file, which plugins cannot write. Plugins never pick the URL.
// - A remote endpoint must be enabled explicitly at setup; otherwise only loopback is allowed.
// - The API key stays in the OS keychain (macOS `security`, Linux `secret-tool`). The core reads it
//   for each request; it is never passed to plugin code, written to disk, or logged.
// Ported from local-ai-harness src/provider.ts (OpenAI-compatible chat completions).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface ModelConfig {
  /** 'local' (Ollama, LM Studio, llama.cpp …), 'deepseek' or 'custom'. */
  provider: 'local' | 'deepseek' | 'custom';
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1. */
  baseUrl: string;
  model: string;
  /** Keychain item holding the API key, if the endpoint needs one. */
  key?: { service: string; account: string };
  /** Required for any non-loopback endpoint; set only by `agentbelt agent setup`. */
  allowRemote?: boolean;
  maxTokens?: number;
}

export const PRESETS: Record<ModelConfig['provider'], { baseUrl: string; model: string }> = {
  local: { baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { baseUrl: '', model: '' },
};

export const KEYCHAIN_SERVICE = 'agentbelt-agent';

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  /** Set when the model sent arguments that are not a JSON object. */
  error?: string;
}
export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** The assistant message to append to the conversation. */
  assistantMessage: ChatMessage;
}

export interface ModelClient {
  readonly model: string;
  readonly endpoint: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopback = (url: URL) =>
  LOOPBACK.has(url.hostname) || url.hostname.endsWith('.localhost');

/** Checks a config; returns the problem, or null. */
export function checkModelConfig(c: ModelConfig): string | null {
  let url: URL;
  try {
    url = new URL(c.baseUrl);
  } catch {
    return `invalid base URL "${c.baseUrl}"`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `unsupported protocol ${url.protocol}`;
  if (url.username || url.password)
    return 'credentials in the URL are not allowed (use the keychain)';
  if (!isLoopback(url)) {
    if (!c.allowRemote)
      return `${url.host} is not on this machine; remote endpoints must be enabled at setup`;
    if (url.protocol !== 'https:') return `remote endpoint ${url.host} must use https`;
  }
  if (!c.model) return 'no model chosen';
  return null;
}

export function loadModelConfig(file: string): ModelConfig | null {
  if (!existsSync(file)) return null;
  const c = JSON.parse(readFileSync(file, 'utf8')) as ModelConfig;
  const problem = checkModelConfig(c);
  if (problem) throw new Error(`agent model config ${file}: ${problem}`);
  return c;
}

/** Reads a secret from the OS keychain; null if there is none. */
export function readSecret(service: string, account: string): string | null {
  try {
    if (process.platform === 'darwin')
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    if (process.platform === 'linux')
      return execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
  } catch {
    return null;
  }
  return null;
}

export interface ClientOptions {
  /** Returns the API key (default: from the keychain item in the config). */
  secret?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createModelClient(c: ModelConfig, o: ClientOptions = {}): ModelClient {
  const problem = checkModelConfig(c);
  if (problem) throw new Error(problem);
  const base = c.baseUrl.replace(/\/+$/, '');
  const secret = o.secret ?? (() => (c.key ? readSecret(c.key.service, c.key.account) : null));
  const doFetch = o.fetchImpl ?? fetch;
  return {
    model: c.model,
    endpoint: new URL(base).host,
    async chat(request) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (c.key) {
        const key = secret();
        if (!key)
          throw new Error(
            `no API key in the keychain (${c.key.service}/${c.key.account}); run: agentbelt agent setup`,
          );
        headers.Authorization = `Bearer ${key}`;
      }
      const payload: Record<string, unknown> = {
        model: c.model,
        messages: request.messages,
        stream: false,
        max_tokens: request.maxTokens ?? c.maxTokens ?? 4096,
      };
      if (request.tools?.length) payload.tools = request.tools;
      const response = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error', // never follow a redirect to another host with the key
        signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(`model endpoint returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('model endpoint returned invalid JSON');
      }
      const choice = body?.choices?.[0];
      const message = choice?.message;
      if (!message) throw new Error('model response has no choices[0].message');
      const content = typeof message.content === 'string' ? message.content : null;
      const wire: WireToolCall[] = [];
      const toolCalls: ToolCall[] = [];
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach(
        (raw: any, i: number) => {
          const id = typeof raw?.id === 'string' && raw.id ? raw.id : `call_${i}`;
          const name = typeof raw?.function?.name === 'string' ? raw.function.name : '';
          const a = raw?.function?.arguments;
          const rawArgs = typeof a === 'string' ? a : JSON.stringify(a ?? {});
          wire.push({ id, type: 'function', function: { name, arguments: rawArgs } });
          let parsed: unknown;
          try {
            parsed = typeof a === 'string' ? JSON.parse(a || '{}') : (a ?? {});
          } catch (e) {
            return toolCalls.push({
              id,
              name,
              error: `invalid JSON arguments: ${(e as Error).message}`,
            });
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return toolCalls.push({ id, name, error: 'arguments are not a JSON object' });
          toolCalls.push({ id, name, arguments: parsed as Record<string, unknown> });
        },
      );
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      return {
        content,
        toolCalls,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        usage: {
          inputTokens: num(body.usage?.prompt_tokens),
          outputTokens: num(body.usage?.completion_tokens),
        },
        assistantMessage: {
          role: 'assistant',
          content,
          ...(wire.length ? { tool_calls: wire } : {}),
        },
      };
    },
  };
}
