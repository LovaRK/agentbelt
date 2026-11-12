// Context-window status, recorded only from data a client or provider actually reports.
// Nothing here estimates: if a value isn't reported it is shown as UNKNOWN. Context window
// (tokens in the current conversation) is a different thing from rate limits or account quotas,
// and this file only tracks the context window.
// At 80% used (20% left) a warning is raised and the project state is checkpointed with a handoff.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, ProjectState } from './project-state.js';

export const WARN_AT = 0.8;

export interface ContextStatus {
  client: string;
  model: string | null;
  limit: number | null;
  used: number | null;
  /** Where the numbers came from, e.g. "claude-code statusline (context_window)". */
  source: string;
  at: string;
}

export function contextView(c: ContextStatus | null) {
  const known = c && c.limit && c.used !== null && c.limit > 0;
  const remaining = known ? c!.limit! - c!.used! : null;
  const ratio = known ? c!.used! / c!.limit! : null;
  return {
    client: c?.client ?? 'UNKNOWN',
    model: c?.model ?? 'UNKNOWN',
    limit: c?.limit ?? 'UNKNOWN',
    used: c?.used ?? 'UNKNOWN',
    remaining: remaining ?? 'UNKNOWN',
    remainingPercent: ratio === null ? 'UNKNOWN' : `${Math.round((1 - ratio) * 100)}%`,
    warning: ratio !== null && ratio >= WARN_AT,
    source: c?.source ?? 'no client has reported usage',
    at: c?.at ?? null,
  };
}

export function readContext(root: string): ContextStatus | null {
  try {
    return JSON.parse(readFileSync(join(root, '.agentbelt', 'CONTEXT_STATUS.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Records reported usage. Returns the view; when it crosses the warning threshold, saves a
 * checkpoint and refreshes HANDOFF.md so a new session or compaction loses nothing.
 */
export function recordContext(root: string, c: Omit<ContextStatus, 'at'>) {
  const entry: ContextStatus = {
    ...c,
    client: clean(c.client),
    model: c.model && clean(c.model),
    at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries({ limit: entry.limit, used: entry.used }))
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`invalid ${k}: ${v}`);
  const dir = join(root, '.agentbelt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'CONTEXT_STATUS.json');
  const before = readContext(root);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  const view = contextView(entry);
  const wasWarning = before ? contextView(before).warning && before.client === entry.client : false;
  if (view.warning && !wasWarning) {
    const state = new ProjectState(root);
    if (state.exists())
      state.checkpoint(
        `context ${view.remainingPercent} left in ${entry.client} — saved state and handoff; compact or start a new session, then run \`agentbelt resume\``,
        undefined,
        entry.client,
      );
  }
  return view;
}

/**
 * Reads the JSON Claude Code passes to a status-line command. Uses only the context fields if the
 * installed Claude Code version provides them; otherwise the usage stays UNKNOWN.
 */
export function fromClaudeStatusline(json: unknown): Omit<ContextStatus, 'at'> {
  const j = (json ?? {}) as Record<string, any>;
  const cw = j.context_window ?? {};
  const limit = num(cw.context_window_size);
  let used = num(cw.total_input_tokens ?? cw.used_tokens);
  if (used === null && limit !== null && num(cw.used_percentage) !== null)
    used = Math.round((num(cw.used_percentage)! / 100) * limit);
  return {
    client: 'claude-code',
    model: j.model?.id ?? j.model?.display_name ?? null,
    limit,
    used,
    source:
      limit !== null && used !== null
        ? 'claude-code statusline (context_window)'
        : 'claude-code statusline (no context data in this version)',
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const contextFileExists = (root: string) =>
  existsSync(join(root, '.agentbelt', 'CONTEXT_STATUS.json'));
