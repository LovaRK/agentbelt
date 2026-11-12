// Local model discovery (read-only) and task routing.
// Discovery runs only `ollama list`, `ollama ps`, `ollama show <model>` and a GET to LM Studio's
// local /v1/models. It never pulls, deletes or changes models.
// Routing is local-first, never sends work to a cloud model by itself, and checks capabilities
// (tool calling, context size) before choosing a model.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

export interface LocalModel {
  name: string;
  provider: 'ollama' | 'lmstudio';
  sizeGB: number | null;
  running: boolean;
  /** Maximum context the model supports. */
  maxContext: number | null;
  /** Context the model is configured to use (Ollama num_ctx), if set. */
  configuredContext: number | null;
  capabilities: string[];
  fitsInMemory: boolean | null;
}

export interface ModelRegistry {
  discoveredAt: string;
  memoryGB: number;
  providers: {
    ollama: 'available' | 'not installed' | 'not running';
    lmstudio: 'available' | 'not running';
  };
  models: LocalModel[];
  /** Preferred order for local work (first available wins). */
  priority: string[];
}

export type Runner = (cmd: string, args: string[]) => string | null;
const defaultRunner: Runner = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
  } catch {
    return null;
  }
};

/** Parses `ollama show` output. */
export function parseOllamaShow(text: string) {
  const section = (name: string) => {
    const m = new RegExp(`^\\s*${name}\\s*\\n([\\s\\S]*?)(?:\\n\\s*\\n|(?![\\s\\S]))`, 'm').exec(
      text,
    );
    return m ? m[1] : '';
  };
  const maxContext = Number(/context length\s+(\d+)/.exec(text)?.[1]) || null;
  const configuredContext = Number(/num_ctx\s+(\d+)/.exec(text)?.[1]) || null;
  const capabilities = section('Capabilities')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((c) => c && /^[a-z]+$/.test(c) && c !== 'levels' && c !== 'default');
  return { maxContext, configuredContext, capabilities };
}

export async function discoverModels(
  run: Runner = defaultRunner,
  fetchJson: (url: string) => Promise<any> = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.json();
  },
  priority: string[] = [
    'gpt-oss-20b-16k:latest',
    'gpt-oss-20b-32k:latest',
    'gpt-oss:20b',
    'qwen3.8:27b',
    'gemma4:12b-mlx',
  ],
  /** Machine memory in GB (default: this machine's); tests pass a fixed value. */
  memoryGB = Math.round(totalmem() / 1e9),
): Promise<ModelRegistry> {
  const models: LocalModel[] = [];
  const list = run('ollama', ['list']);
  let ollama: ModelRegistry['providers']['ollama'] = list === null ? 'not installed' : 'available';
  if (list !== null) {
    const ps = run('ollama', ['ps']) ?? '';
    const running = new Set(
      ps
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
    for (const line of list.split('\n').slice(1)) {
      const cols = line.trim().split(/\s{2,}/);
      if (!cols[0]) continue;
      const size = /([\d.]+)\s*GB/.exec(cols[2] ?? '');
      const show = parseOllamaShow(run('ollama', ['show', cols[0]]) ?? '');
      const sizeGB = size ? Number(size[1]) : null;
      models.push({
        name: cols[0],
        provider: 'ollama',
        sizeGB,
        running: running.has(cols[0]),
        ...show,
        // Weights need to fit with headroom for the OS and context (rule of thumb: 75% of RAM).
        fitsInMemory: sizeGB === null ? null : sizeGB < memoryGB * 0.75,
      });
    }
  }
  let lmstudio: ModelRegistry['providers']['lmstudio'] = 'not running';
  try {
    const r = await fetchJson('http://127.0.0.1:1234/v1/models');
    lmstudio = 'available';
    for (const m of r?.data ?? [])
      models.push({
        name: String(m.id),
        provider: 'lmstudio',
        sizeGB: null,
        running: true,
        maxContext: null,
        configuredContext: null,
        capabilities: [],
        fitsInMemory: null,
      });
  } catch {
    // LM Studio isn't running; that's fine.
  }
  return {
    discoveredAt: new Date().toISOString(),
    memoryGB,
    providers: { ollama, lmstudio },
    models,
    priority,
  };
}

export function saveRegistry(root: string, reg: ModelRegistry): void {
  const dir = join(root, '.agentbelt');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'MODEL_REGISTRY.json');
  writeFileSync(`${f}.tmp`, `${JSON.stringify(reg, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
}
export function loadRegistry(root: string): ModelRegistry | null {
  try {
    return JSON.parse(readFileSync(join(root, '.agentbelt', 'MODEL_REGISTRY.json'), 'utf8'));
  } catch {
    return null;
  }
}

export type TaskKind =
  | 'deterministic'
  | 'code-analysis'
  | 'test-summary'
  | 'documentation'
  | 'architecture'
  | 'high-risk-change';

export interface Route {
  kind: TaskKind;
  target: 'none' | 'local' | 'user-selected';
  model: string | null;
  reason: string;
  verificationRequired: boolean;
}

const NEEDS: Record<TaskKind, { tools: boolean; minContext: number }> = {
  deterministic: { tools: false, minContext: 0 },
  'code-analysis': { tools: true, minContext: 16_000 },
  'test-summary': { tools: false, minContext: 8_000 },
  documentation: { tools: false, minContext: 8_000 },
  architecture: { tools: true, minContext: 32_000 },
  'high-risk-change': { tools: true, minContext: 32_000 },
};

/**
 * Picks where a task should run. Local models are checked for capability, context and memory;
 * running models are preferred, then the priority order. Complex and high-risk work goes to a
 * model the USER selects (never picked automatically, never sent to a cloud silently).
 */
export function route(
  kind: TaskKind,
  reg: ModelRegistry | null,
  opts: { allowLocalForComplex?: boolean } = {},
): Route {
  const need = NEEDS[kind];
  if (!need) throw new Error(`unknown task kind ${kind}`);
  if (kind === 'deterministic')
    return {
      kind,
      target: 'none',
      model: null,
      reason: 'deterministic operation: no model needed',
      verificationRequired: false,
    };
  const complex = kind === 'architecture' || kind === 'high-risk-change';
  const candidates = (reg?.models ?? [])
    .filter((m) => m.fitsInMemory !== false)
    .filter((m) => !need.tools || m.capabilities.includes('tools'))
    // Only a configured context counts: without num_ctx, Ollama uses its own (smaller) default,
    // not the model's maximum.
    .filter((m) => (m.configuredContext ?? 0) >= need.minContext)
    .sort(
      (a, b) => Number(b.running) - Number(a.running) || rank(reg!, a.name) - rank(reg!, b.name),
    );
  if (complex && !opts.allowLocalForComplex)
    return {
      kind,
      target: 'user-selected',
      model: candidates[0]?.name ?? null,
      reason: `${kind}: use a capable model you choose${candidates[0] ? ` (local option: ${candidates[0].name})` : ''}; agentbelt never sends project code to a cloud model by itself`,
      verificationRequired: kind === 'high-risk-change',
    };
  if (!candidates.length)
    return {
      kind,
      target: 'user-selected',
      model: null,
      reason: `no local model meets ${need.tools ? 'tool calling + ' : ''}a configured context of ${need.minContext}; choose a model (or set num_ctx on a local one)`,
      verificationRequired: complex,
    };
  const m = candidates[0];
  return {
    kind,
    target: 'local',
    model: m.name,
    reason: `${m.name}: ${m.running ? 'running' : 'installed (will load)'}, configured context ${m.configuredContext}, ${m.capabilities.join('/')}`,
    verificationRequired: complex,
  };
}

function rank(reg: ModelRegistry, name: string): number {
  const i = reg.priority.indexOf(name);
  return i < 0 ? 999 : i;
}
