// Context compaction for long agent runs on models with small context windows (e.g. 16k).
//
// Deterministic, no model call and no network: it only rewrites the content of old tool results.
// It never drops or reorders messages, so every assistant tool call keeps its matching tool
// result (OpenAI-compatible servers reject a conversation where they don't match).
//
// - The system prompt, the task and the most recent messages are kept as they are.
// - A tool result repeated word for word later in the run is replaced by a short pointer.
// - While the conversation is over the token budget, older tool results (large file reads, test
//   logs) are summarized oldest first: first and last lines, plus lines that look like errors.
// - If that is not enough, those summaries shrink to a one-line header.
//
// Sizes here are estimates (about 4 characters per token) used only to decide what to compact.
// The token counts agentbelt reports come from the model server's own usage numbers.
import type { ChatMessage } from '@agentbelt/core';

export interface CompactionOptions {
  /** Estimated token budget for the messages sent to the model. */
  budgetTokens: number;
  /** The newest messages kept exactly as they are (default 4). */
  keepRecent?: number;
  /**
   * Terms whose lines a summary keeps (default: identifiers, file names and quoted words from
   * the task, the first user message).
   */
  focus?: string[];
}

export interface CompactionStats {
  /** Tool results replaced because the same output came back again later. */
  duplicates: number;
  /** Older tool results replaced by a summary. */
  summarized: number;
  estimatedBefore: number;
  estimatedAfter: number;
}

export const COMPACTED = '[agentbelt compacted]';
const ERROR_LINE = /\b(error|fail(ed|ure)?|not ok|exception|panic|assert)|✗|✖|FAIL|ERR!/i;
/** Shorter results are cheap to keep and often matter (e.g. "wrote x.ts"). */
const MIN_COMPACT_CHARS = 400;

/** Rough token estimate for budgeting: about 4 characters per token, plus per-message overhead. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? '').length + 16;
    if (m.role === 'assistant' && m.tool_calls)
      for (const c of m.tool_calls) chars += c.function.name.length + c.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Terms worth keeping from a task: identifiers (snake_case, camelCase, CONSTANTS), file names and
 * quoted words. Plain English words are left out, so a summary keeps few, specific lines.
 */
export function focusTerms(task: string): string[] {
  const terms = new Set<string>();
  for (const m of task.matchAll(/[`'"]([^`'"\n]{3,60})[`'"]/g)) terms.add(m[1]);
  for (const w of task.match(/[A-Za-z_$][\w$.\/-]{2,}/g) ?? [])
    if (/_|[a-z][A-Z]|\.[a-z]{1,4}$|^[A-Z][A-Z0-9]{2,}$/.test(w))
      terms.add(w.replace(/[.,]+$/, ''));
  return [...terms];
}

/**
 * Summary of one tool output: what it was, how big, and the lines most likely to matter (lines
 * that mention a focus term, lines that look like errors, and the first and last lines).
 */
export function summarizeOutput(
  label: string,
  text: string,
  focus: string[] = [],
  maxLines = 30,
): string {
  const lines = text.split('\n');
  const head = lines.slice(0, 6);
  const tail = lines.length > 10 ? lines.slice(-3) : [];
  const middle = lines.slice(head.length, lines.length - tail.length);
  const lower = focus.map((f) => f.toLowerCase());
  const relevant = middle
    .map((l, i) => ({ l, n: i + head.length + 1 }))
    .filter(({ l }) => {
      const x = l.toLowerCase();
      return lower.some((f) => x.includes(f)) || ERROR_LINE.test(l);
    })
    .slice(0, maxLines - head.length - tail.length);
  const clipLine = (l: string) => (l.length > 200 ? `${l.slice(0, 200)}…` : l);
  return [
    `${COMPACTED} ${label} was already run; its output (${lines.length} lines) is shortened here to save context. Kept: the first and last lines${relevant.length ? ', and the lines that mention terms from the task or look like errors (with line numbers)' : ''}. Use these lines; repeat the call only if something you need is missing.`,
    ...head.map(clipLine),
    ...(relevant.length ? ['…', ...relevant.map(({ l, n }) => `${n}: ${clipLine(l)}`)] : []),
    ...(tail.length ? ['…', ...tail.map(clipLine)] : []),
  ].join('\n');
}

/** Returns a compacted copy of the conversation (the input is not changed). */
export function compactMessages(
  messages: ChatMessage[],
  options: CompactionOptions,
): { messages: ChatMessage[]; stats: CompactionStats } {
  const out = messages.map((m) => ({ ...m })) as ChatMessage[];
  const stats: CompactionStats = {
    duplicates: 0,
    summarized: 0,
    estimatedBefore: estimateTokens(messages),
    estimatedAfter: 0,
  };
  // What each tool call was, so a summary can say "read_file {"path":"src/a.ts"}".
  const calls = new Map<string, string>();
  for (const m of out)
    if (m.role === 'assistant' && m.tool_calls)
      for (const c of m.tool_calls)
        calls.set(c.id, `${c.function.name} ${c.function.arguments}`.slice(0, 200));
  const label = (m: ChatMessage) =>
    m.role === 'tool' ? (calls.get(m.tool_call_id) ?? 'tool output') : 'output';

  const task = out.find((m) => m.role === 'user')?.content ?? '';
  const focus = options.focus ?? focusTerms(task);
  // Protected: the system prompt and the task (leading system/user messages) and the newest ones.
  let firstMutable = 0;
  while (firstMutable < out.length && out[firstMutable].role !== 'assistant') firstMutable += 1;
  const lastMutable = out.length - Math.max(0, options.keepRecent ?? 4);
  const candidates: number[] = [];
  for (let i = firstMutable; i < lastMutable; i++)
    if (out[i].role === 'tool' && !out[i].content!.startsWith(COMPACTED)) candidates.push(i);

  // 1. Duplicates: keep the newest copy, point to it from the older ones.
  const newest = new Map<string, number>();
  out.forEach((m, i) => {
    if (m.role === 'tool' && m.content.length >= MIN_COMPACT_CHARS) newest.set(m.content, i);
  });
  for (const i of candidates) {
    const m = out[i] as Extract<ChatMessage, { role: 'tool' }>;
    const later = newest.get(m.content);
    if (later !== undefined && later > i) {
      m.content = `${COMPACTED} ${label(m)}: same output as a later call of the same tool; see that result below.`;
      stats.duplicates += 1;
    }
  }

  // 2. Over budget: summarize older tool results, oldest first.
  let size = estimateTokens(out);
  for (const i of candidates) {
    if (size <= options.budgetTokens) break;
    const m = out[i] as Extract<ChatMessage, { role: 'tool' }>;
    if (m.content.startsWith(COMPACTED) || m.content.length < MIN_COMPACT_CHARS) continue;
    m.content = summarizeOutput(label(m), m.content, focus);
    stats.summarized += 1;
    size = estimateTokens(out);
  }
  // 3. Still over budget: shrink those summaries to their header line.
  for (const i of candidates) {
    if (size <= options.budgetTokens) break;
    const m = out[i] as Extract<ChatMessage, { role: 'tool' }>;
    if (!m.content.startsWith(COMPACTED) || !m.content.includes('\n')) continue;
    m.content = m.content.split('\n', 1)[0];
    size = estimateTokens(out);
  }
  stats.estimatedAfter = size;
  return { messages: out, stats };
}
