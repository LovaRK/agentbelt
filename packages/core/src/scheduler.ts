// Opt-in scheduling and triggers for workflows. Off by default; nothing runs unless the user:
//   1. adds a schedule or trigger with the CLI (never through MCP tools: a model cannot schedule
//      work for itself), and
//   2. keeps `agentbelt scheduler run` going in the project.
// Each run is an ordinary workflows_start call through the broker, audited under the client name
// `agentbelt-scheduler`; approval gates still stop the run until the user decides in the CLI.
//
// Triggers: `file` (files matching patterns changed) and `git` (a branch got a new commit), both
// polled locally. Webhook and GitHub triggers are not offered: they need a network listener or
// remote access, which widens the attack surface.
// Event values (file names, commit ids) come from outside, so they are cleaned and clipped before
// they become workflow inputs.
// Cron parsing is ported from local-ai-harness src/scheduler.ts.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// ------------------------------------------------------------------ cron

const FIELDS: [string, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 7],
];

export interface Cron {
  sets: Set<number>[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parses `*`, `5`, `1-5`, `*\/15`, `1-10/2` and comma lists. Day-of-week 7 is Sunday. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (got ${parts.length}): "${expr}"`);
  const sets = parts.map((part, i) => {
    const [name, min, max] = FIELDS[i];
    const set = new Set<number>();
    for (const item of part.split(',')) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`bad ${name} field: "${item}"`);
      const lo = m[1] === '*' ? min : Number(m[1]);
      const hi = m[1] === '*' ? max : m[2] !== undefined ? Number(m[2]) : m[3] ? max : lo;
      const step = m[3] ? Number(m[3]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1)
        throw new Error(`${name} out of range (${min}-${max}): "${item}"`);
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { sets, domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*' };
}

function cronMatches(cron: Cron, d: Date): boolean {
  const [min, hour, dom, month, dow] = cron.sets;
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !month.has(d.getMonth() + 1))
    return false;
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk; // cron's OR rule
  return domOk && dowOk;
}

/** The first minute strictly after `after` that matches (local time), within about 4 years. */
export function nextCronTime(expr: string | Cron, after: Date): Date {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(cron, d)) return d;
  }
  throw new Error('cron expression never matches');
}

// ------------------------------------------------------------------ store

export interface Schedule {
  id: string;
  workflow: string;
  cron?: string;
  /** One-time run (ISO time); removed after it runs. */
  at?: string;
  next: string;
  enabled: boolean;
  lastRun?: { at: string; result: string };
}

export interface Trigger {
  id: string;
  workflow: string;
  type: 'file' | 'git';
  /** file: glob patterns relative to the workspace (`*`, `**`, `?`). */
  paths?: string[];
  /** git: the branch to watch. */
  branch?: string;
  /** Minimum seconds between two runs of this trigger. */
  cooldownSec: number;
  enabled: boolean;
  /** Last seen state: commit id (git) or a fingerprint of matching files (file). */
  cursor?: string;
  lastRun?: { at: string; result: string };
}

export interface SchedulerState {
  schedules: Schedule[];
  triggers: Trigger[];
}

export const schedulerFile = (workspace: string) => join(workspace, '.agentbelt', 'scheduler.json');

export function loadScheduler(workspace: string): SchedulerState {
  const file = schedulerFile(workspace);
  if (!existsSync(file)) return { schedules: [], triggers: [] };
  const s = JSON.parse(readFileSync(file, 'utf8')) as SchedulerState;
  return { schedules: s.schedules ?? [], triggers: s.triggers ?? [] };
}

export function saveScheduler(workspace: string, state: SchedulerState): void {
  const file = schedulerFile(workspace);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

const newId = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;
const WORKFLOW = /^[A-Za-z0-9_-]{1,64}$/;

export function addSchedule(
  state: SchedulerState,
  o: { workflow: string; cron?: string; at?: string },
  now = new Date(),
): Schedule {
  if (!WORKFLOW.test(o.workflow)) throw new Error(`invalid workflow name "${o.workflow}"`);
  if (!o.cron === !o.at) throw new Error('give exactly one of --cron or --at');
  let next: Date;
  if (o.cron) next = nextCronTime(o.cron, now);
  else {
    next = new Date(o.at!);
    if (Number.isNaN(next.getTime())) throw new Error(`invalid time "${o.at}"`);
    if (next <= now) throw new Error(`${o.at} is in the past`);
  }
  const s: Schedule = {
    id: newId('sch'),
    workflow: o.workflow,
    ...(o.cron ? { cron: o.cron } : { at: next.toISOString() }),
    next: next.toISOString(),
    enabled: true,
  };
  state.schedules.push(s);
  return s;
}

export function addTrigger(
  state: SchedulerState,
  o: { workflow: string; type: string; paths?: string[]; branch?: string; cooldownSec?: number },
): Trigger {
  if (!WORKFLOW.test(o.workflow)) throw new Error(`invalid workflow name "${o.workflow}"`);
  if (o.type !== 'file' && o.type !== 'git')
    throw new Error(
      'trigger type must be file or git (webhook and GitHub triggers are not offered)',
    );
  if (o.type === 'file') {
    if (!o.paths?.length) throw new Error('a file trigger needs --paths');
    for (const p of o.paths)
      if (p.startsWith('/') || p.split('/').includes('..'))
        throw new Error(`path patterns must stay inside the project: "${p}"`);
  }
  if (o.branch !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(o.branch))
    throw new Error(`invalid branch "${o.branch}"`);
  const t: Trigger = {
    id: newId('trg'),
    workflow: o.workflow,
    type: o.type,
    ...(o.type === 'file' ? { paths: o.paths } : { branch: o.branch ?? 'main' }),
    cooldownSec: Math.max(30, o.cooldownSec ?? 300),
    enabled: true,
  };
  state.triggers.push(t);
  return t;
}

// ------------------------------------------------------------------ events

/** Untrusted text → a short single-line value safe to pass as a workflow input. */
export function cleanValue(value: unknown, max = 300): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Glob → RegExp: `**` any depth, `*` within one segment, `?` one character. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const SKIP = new Set(['.git', '.agentbelt', 'node_modules']);
const MAX_FILES = 20_000;

/** Matching files with their modification times (skips .git, .agentbelt, node_modules). */
export function scanFiles(workspace: string, patterns: string[]): Map<string, number> {
  const res = patterns.map(globToRegExp);
  const found = new Map<string, number>();
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || ++seen > MAX_FILES) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = relative(workspace, full).split(sep).join('/');
        if (res.some((r) => r.test(rel))) found.set(rel, st.mtimeMs);
      }
    }
  };
  walk(workspace);
  return found;
}

const fingerprint = (files: Map<string, number>) =>
  JSON.stringify([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));

export function gitHead(workspace: string, branch: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export interface DueRun {
  kind: 'schedule' | 'trigger';
  id: string;
  workflow: string;
  inputs: Record<string, string>;
}

/**
 * Works out what should run now and advances the state (next times, cursors). The first look at a
 * trigger only records a baseline, so existing files or commits never fire it.
 */
export function collectDue(
  workspace: string,
  state: SchedulerState,
  now = new Date(),
  probes: { scan?: typeof scanFiles; head?: typeof gitHead } = {},
): DueRun[] {
  const scan = probes.scan ?? scanFiles;
  const head = probes.head ?? gitHead;
  const due: DueRun[] = [];
  for (const s of state.schedules) {
    if (!s.enabled || new Date(s.next) > now) continue;
    due.push({ kind: 'schedule', id: s.id, workflow: s.workflow, inputs: { trigger: 'schedule' } });
    if (s.cron) s.next = nextCronTime(s.cron, now).toISOString();
    else s.enabled = false; // one-time
  }
  for (const t of state.triggers) {
    if (!t.enabled) continue;
    let cursor: string | null;
    let inputs: Record<string, string>;
    if (t.type === 'git') {
      cursor = head(workspace, t.branch!);
      inputs = { trigger: 'git', branch: cleanValue(t.branch), commit: cleanValue(cursor, 64) };
    } else {
      const files = scan(workspace, t.paths!);
      cursor = fingerprint(files);
      let changed: string[] = [];
      if (t.cursor) {
        const before = new Map<string, number>(JSON.parse(t.cursor));
        changed = [...files.keys()].filter((f) => before.get(f) !== files.get(f));
        changed.push(...[...before.keys()].filter((f) => !files.has(f)));
      }
      inputs = { trigger: 'file', changed: cleanValue(changed.slice(0, 20).join(', '), 1000) };
    }
    if (cursor === null) continue;
    if (t.cursor === undefined) {
      t.cursor = cursor; // baseline
      continue;
    }
    if (cursor === t.cursor) continue;
    const last = t.lastRun ? new Date(t.lastRun.at).getTime() : 0;
    if (now.getTime() - last < t.cooldownSec * 1000) continue; // fires on a later tick
    t.cursor = cursor;
    due.push({ kind: 'trigger', id: t.id, workflow: t.workflow, inputs });
  }
  return due;
}
