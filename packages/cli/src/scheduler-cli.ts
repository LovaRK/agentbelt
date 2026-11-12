// `agentbelt schedule …`, `agentbelt trigger …` and `agentbelt scheduler run`.
// Schedules and triggers are created only here, by the user; `scheduler run` is a foreground
// process the user starts (and stops with Ctrl-C). See packages/core/src/scheduler.ts.
import {
  addSchedule,
  addTrigger,
  collectDue,
  createAgentbeltServer,
  loadScheduler,
  saveScheduler,
  type DueRun,
  type SchedulerState,
} from '@agentbelt/core';
import { loadWorkflows } from '@agentbelt/plugin-workflows';
import { FIRST_PARTY } from './plugins.js';
import { skillsDir } from './paths.js';

interface IO {
  flag(name: string): string | undefined;
  has(name: string): boolean;
  say(s?: string): void;
  out(s: string): void;
}

export function schedulerServer(version: string, workspace: string) {
  return createAgentbeltServer({
    version,
    plugins: FIRST_PARTY,
    workspace,
    skillsDirs: [skillsDir()],
    clientName: 'agentbelt-scheduler',
  });
}

async function workflowInputs(
  s: ReturnType<typeof schedulerServer>,
  name: string,
): Promise<string[]> {
  const ctx = await s.contextFor('workflows');
  const def = (await loadWorkflows(ctx)).find((w) => w.name === name);
  if (!def) throw new Error(`no workflow named ${name} (see: agentbelt workflows list)`);
  return Object.keys(def.inputs ?? {});
}

/** Runs one due item: only event fields the workflow declares are passed as inputs. */
async function runOne(s: ReturnType<typeof schedulerServer>, d: DueRun): Promise<string> {
  let declared: string[];
  try {
    declared = await workflowInputs(s, d.workflow);
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
  const inputs = Object.fromEntries(Object.entries(d.inputs).filter(([k]) => declared.includes(k)));
  const r = await s.invoke('workflows_start', { name: d.workflow, inputs });
  const state = (r.data as { state?: string } | undefined)?.state;
  return r.isError ? `error: ${r.text.split('\n')[0]}` : (state ?? 'started');
}

/** One pass: run everything that is due now. Returns what ran. */
export async function tick(
  version: string,
  workspace: string,
  now = new Date(),
): Promise<{ item: DueRun; result: string }[]> {
  const state = loadScheduler(workspace);
  const due = collectDue(workspace, state, now);
  saveScheduler(workspace, state); // next times and trigger baselines
  if (!due.length) return [];
  const s = schedulerServer(version, workspace);
  const done: { item: DueRun; result: string }[] = [];
  for (const item of due) {
    const result = await runOne(s, item);
    done.push({ item, result });
    // Re-read so edits made with the CLI meanwhile are kept.
    const fresh = loadScheduler(workspace);
    const list: { id: string; lastRun?: unknown }[] =
      item.kind === 'schedule' ? fresh.schedules : fresh.triggers;
    const entry = list.find((x) => x.id === item.id);
    if (entry) entry.lastRun = { at: now.toISOString(), result };
    saveScheduler(workspace, fresh);
  }
  return done;
}

function show(state: SchedulerState, io: IO) {
  for (const s of state.schedules)
    io.out(
      `${s.id}  ${s.enabled ? 'on ' : 'off'}  ${s.workflow.padEnd(20)} ${s.cron ? `cron "${s.cron}"` : `at ${s.at}`}  next ${s.enabled ? s.next : '-'}${s.lastRun ? `  last: ${s.lastRun.result}` : ''}`,
    );
  for (const t of state.triggers)
    io.out(
      `${t.id}  ${t.enabled ? 'on ' : 'off'}  ${t.workflow.padEnd(20)} ${t.type === 'git' ? `git branch ${t.branch}` : `files ${t.paths!.join(',')}`}  cooldown ${t.cooldownSec}s${t.lastRun ? `  last: ${t.lastRun.result}` : ''}`,
    );
  if (!state.schedules.length && !state.triggers.length) io.out('no schedules or triggers');
}

export async function scheduleCommand(
  kind: 'schedule' | 'trigger' | 'scheduler',
  args: string[],
  workspace: string,
  version: string,
  io: IO,
): Promise<void> {
  const sub = args.shift() ?? 'list';
  const state = loadScheduler(workspace);
  if (kind === 'scheduler') {
    if (sub !== 'run')
      throw new Error('usage: agentbelt scheduler run [--once] [--interval <sec>]');
    const interval = Math.max(10, Number(io.flag('--interval') ?? 30)) * 1000;
    io.say(
      `agentbelt scheduler: ${state.schedules.filter((s) => s.enabled).length} schedule(s), ${state.triggers.filter((t) => t.enabled).length} trigger(s) in ${workspace}`,
    );
    for (;;) {
      for (const { item, result } of await tick(version, workspace))
        io.say(`${new Date().toISOString()}  ${item.id} → ${item.workflow}: ${result}`);
      if (io.has('--once')) return;
      io.say(`  (checking every ${interval / 1000}s; stop with Ctrl-C)`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  if (sub === 'list') return show(state, io);
  if (sub === 'add') {
    const workflow = args.shift() ?? '';
    await workflowInputs(schedulerServer(version, workspace), workflow); // must exist
    const created =
      kind === 'schedule'
        ? addSchedule(state, { workflow, cron: io.flag('--cron'), at: io.flag('--at') })
        : addTrigger(state, {
            workflow,
            type: io.flag('--on') ?? '',
            paths: io
              .flag('--paths')
              ?.split(',')
              .map((p) => p.trim())
              .filter(Boolean),
            branch: io.flag('--branch'),
            cooldownSec: io.flag('--cooldown') ? Number(io.flag('--cooldown')) : undefined,
          });
    saveScheduler(workspace, state);
    io.say(`✓ added ${created.id}. It runs only while "agentbelt scheduler run" is running here.`);
    return;
  }
  const id = args.shift() ?? '';
  const list: { id: string; enabled: boolean }[] =
    kind === 'schedule' ? state.schedules : state.triggers;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`no ${kind} ${id} (see: agentbelt ${kind} list)`);
  if (sub === 'remove') list.splice(i, 1);
  else if (sub === 'enable' || sub === 'disable') list[i].enabled = sub === 'enable';
  else
    throw new Error(
      `usage: agentbelt ${kind} list | add | remove <id> | enable <id> | disable <id>`,
    );
  saveScheduler(workspace, state);
  io.say(`✓ ${kind} ${id}: ${sub}d`);
}
