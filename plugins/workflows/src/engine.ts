// A small workflow engine. A workflow is a list of steps; each step either calls a tool
// (`uses: "testing_run_checks"`) or is an approval gate the user decides in the CLI. Runs are
// started by the user (no scheduler or triggers in v0.1), persisted after every step, and a
// run waiting for approval continues when the user approves.
import type { PluginContext, ToolResult } from '@agentbelt/core';
import { randomBytes } from 'node:crypto';

export interface StepDefinition {
  id: string;
  /** Tool to call, e.g. "git_status". Exactly one of `uses` / `approval`. */
  uses?: string;
  with?: Record<string, unknown>;
  /** Approval gate: the message shown to the user. */
  approval?: string;
  needs?: string[];
  /** Run when the needed steps all succeeded (default), any failed, or always. */
  if?: 'success' | 'failure' | 'always';
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Input names with default values. */
  inputs?: Record<string, string>;
  steps: StepDefinition[];
}

export type StepState =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting_approval' | 'rejected';
export type RunState = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'rejected';

export interface Run {
  id: string;
  workflow: string;
  definition: WorkflowDefinition;
  inputs: Record<string, string>;
  state: RunState;
  steps: Record<
    string,
    { state: StepState; output?: Record<string, unknown>; text?: string; note?: string }
  >;
  log: string[];
  createdAt: string;
  updatedAt: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validates a definition and returns the steps in a valid execution order. */
export function validate(def: WorkflowDefinition, tools: string[]): StepDefinition[] {
  if (!def || !NAME.test(def.name ?? ''))
    throw new Error('workflow name may use letters, digits, - and _');
  if (!Array.isArray(def.steps) || !def.steps.length)
    throw new Error('workflow needs at least one step');
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (!ID.test(s.id ?? '')) throw new Error(`invalid step id "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (!!s.uses === !!s.approval)
      throw new Error(`step ${s.id}: set exactly one of "uses" or "approval"`);
    if (s.uses && !tools.includes(s.uses))
      throw new Error(`step ${s.id}: tool ${s.uses} is not installed`);
  }
  for (const s of def.steps)
    for (const n of s.needs ?? [])
      if (!ids.has(n)) throw new Error(`step ${s.id} needs unknown step ${n}`);
  const order: StepDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: StepDefinition) => {
    if (state.get(s.id) === 'done') return;
    if (state.get(s.id) === 'visiting') throw new Error(`cycle through step ${s.id}`);
    state.set(s.id, 'visiting');
    for (const n of s.needs ?? []) visit(def.steps.find((x) => x.id === n)!);
    state.set(s.id, 'done');
    order.push(s);
  };
  def.steps.forEach(visit);
  return order;
}

/** Replaces ${inputs.x} and ${steps.id.field} in strings, recursively. */
export function interpolate(value: unknown, run: Run): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\$\{(inputs|steps)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?\}/g,
      (_, kind, a, b) => {
        if (kind === 'inputs') return run.inputs[a] ?? '';
        const out = run.steps[a]?.output?.[b ?? ''];
        return out === undefined ? '' : typeof out === 'string' ? out : JSON.stringify(out);
      },
    );
  if (Array.isArray(value)) return value.map((v) => interpolate(v, run));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, run)]));
  return value;
}

const now = () => new Date().toISOString();
const key = (id: string) => `run-${id}`;

export function saveRun(ctx: PluginContext, run: Run): void {
  run.updatedAt = now();
  ctx.state.set(key(run.id), run);
}
export function getRun(ctx: PluginContext, id: string): Run | undefined {
  return /^[a-z0-9-]{1,60}$/.test(id) ? ctx.state.get<Run>(key(id)) : undefined;
}
export function listRuns(ctx: PluginContext): Run[] {
  return ctx.state
    .list()
    .filter((k) => k.startsWith('run-'))
    .map((k) => ctx.state.get<Run>(k)!)
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createRun(
  def: WorkflowDefinition,
  inputs: Record<string, string>,
  tools: string[],
): Run {
  validate(def, tools);
  const unknown = Object.keys(inputs).filter((k) => !(k in (def.inputs ?? {})));
  if (unknown.length) throw new Error(`unknown input(s): ${unknown.join(', ')}`);
  const stamp = now().replace(/[-:T]/g, '').slice(0, 14);
  return {
    id: `${stamp}-${randomBytes(2).toString('hex')}`,
    workflow: def.name,
    definition: def,
    inputs: { ...(def.inputs ?? {}), ...inputs },
    state: 'running',
    steps: Object.fromEntries(def.steps.map((s) => [s.id, { state: 'pending' as StepState }])),
    log: [`${now()} started`],
    createdAt: now(),
    updatedAt: now(),
  };
}

/** Runs pending steps in order until the run finishes or reaches an undecided approval gate. */
export async function execute(ctx: PluginContext, run: Run, tools: string[]): Promise<Run> {
  const order = validate(run.definition, tools);
  run.state = 'running';
  saveRun(ctx, run);
  for (const step of order) {
    const rec = run.steps[step.id];
    if (!['pending', 'waiting_approval'].includes(rec.state)) continue;
    const needs = (step.needs ?? []).map((n) => run.steps[n].state);
    if (needs.some((s) => ['pending', 'running', 'waiting_approval'].includes(s))) continue;
    const anyFailed = needs.some((s) => ['failed', 'rejected', 'skipped'].includes(s));
    const cond = step.if ?? 'success';
    if ((cond === 'success' && anyFailed) || (cond === 'failure' && !anyFailed)) {
      rec.state = 'skipped';
      run.log.push(`${now()} ${step.id}: skipped (${cond})`);
      saveRun(ctx, run);
      continue;
    }
    if (step.approval) {
      rec.state = 'waiting_approval';
      run.state = 'waiting_approval';
      run.log.push(
        `${now()} ${step.id}: waiting for approval — ${interpolate(step.approval, run)}`,
      );
      saveRun(ctx, run);
      return run;
    }
    rec.state = 'running';
    saveRun(ctx, run);
    let result: ToolResult;
    try {
      result = await ctx.callTool(
        step.uses!,
        interpolate(step.with ?? {}, run) as Record<string, unknown>,
      );
    } catch (error) {
      result = { text: (error as Error).message, isError: true };
    }
    const failed = !!result.isError || result.data?.passed === false;
    rec.state = failed ? 'failed' : 'succeeded';
    rec.output = result.data;
    rec.text = result.text.slice(0, 4000);
    run.log.push(`${now()} ${step.id}: ${step.uses} → ${rec.state}`);
    saveRun(ctx, run);
  }
  const states = Object.values(run.steps).map((s) => s.state);
  run.state = states.includes('rejected')
    ? 'rejected'
    : states.includes('failed')
      ? 'failed'
      : 'succeeded';
  run.log.push(`${now()} finished: ${run.state}`);
  saveRun(ctx, run);
  return run;
}

/** Records the user's decision on a waiting approval step (CLI only, never an MCP tool). */
export function decide(run: Run, stepId: string, approved: boolean, note = ''): void {
  const rec = run.steps[stepId];
  if (!rec || rec.state !== 'waiting_approval')
    throw new Error(`step ${stepId} is not waiting for approval`);
  rec.state = approved ? 'succeeded' : 'rejected';
  rec.output = { approved, note };
  rec.note = note;
  run.log.push(
    `${now()} ${stepId}: ${approved ? 'approved' : 'rejected'} by the user${note ? ` (${note})` : ''}`,
  );
}

export function describe(run: Run): string {
  const lines = [`${run.id}  ${run.workflow}  ${run.state}`];
  for (const s of run.definition.steps) {
    const rec = run.steps[s.id];
    lines.push(`  ${rec.state.padEnd(16)} ${s.id}${s.uses ? `  (${s.uses})` : '  (approval)'}`);
    if (rec.text && rec.state !== 'pending')
      lines.push(
        rec.text
          .split('\n')
          .slice(0, 25)
          .map((l) => `      ${l}`)
          .join('\n'),
      );
  }
  const waiting = run.definition.steps.find((s) => run.steps[s.id].state === 'waiting_approval');
  if (waiting)
    lines.push(
      `\nWaiting for approval: ${interpolate(waiting.approval, run)}\n` +
        `  The user decides in a terminal:  agentbelt approve ${run.id} ${waiting.id}   (or: agentbelt reject …)`,
    );
  return lines.join('\n');
}
