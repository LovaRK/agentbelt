// Opt-in scheduler and triggers: cron, validation, event detection, and real runs through the broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addSchedule,
  addTrigger,
  cleanValue,
  collectDue,
  globToRegExp,
  loadScheduler,
  nextCronTime,
  parseCron,
  saveScheduler,
  type SchedulerState,
} from '@agentbelt/core';
import { tick } from '../packages/cli/src/scheduler-cli.ts';
import { tempRepo } from './helpers.ts';

const at = (s: string) => new Date(s); // local time

test('cron: steps, ranges, weekdays, and errors', () => {
  assert.equal(
    nextCronTime('*/15 * * * *', at('2026-11-12T10:07:30')).toString(),
    at('2026-11-12T10:15:00').toString(),
  );
  // Friday 17:00 → Monday 09:00 for "weekdays at 9".
  assert.equal(
    nextCronTime('0 9 * * 1-5', at('2026-11-13T17:00:00')).toString(),
    at('2026-11-16T09:00:00').toString(),
  );
  assert.equal(nextCronTime('0 0 * * 7', at('2026-11-12T00:00:00')).getDay(), 0); // 7 = Sunday
  assert.throws(() => parseCron('* * * *'), /5 fields/);
  assert.throws(() => parseCron('60 * * * *'), /out of range/);
  assert.throws(() => parseCron('a * * * *'), /bad minute/);
});

test('only CLI-created, validated schedules and local triggers; no webhook/GitHub', () => {
  const st: SchedulerState = { schedules: [], triggers: [] };
  const now = at('2026-11-12T10:00:00');
  assert.throws(() => addSchedule(st, { workflow: 'x' }, now), /exactly one/);
  assert.throws(() => addSchedule(st, { workflow: 'x', at: '2020-01-01T00:00:00Z' }, now), /past/);
  assert.throws(
    () => addSchedule(st, { workflow: '../x', cron: '* * * * *' }, now),
    /invalid workflow/,
  );
  assert.throws(() => addTrigger(st, { workflow: 'x', type: 'webhook' }), /not offered/);
  assert.throws(
    () => addTrigger(st, { workflow: 'x', type: 'file', paths: ['../etc/*'] }),
    /inside the project/,
  );
  assert.throws(
    () => addTrigger(st, { workflow: 'x', type: 'file', paths: ['/etc/*'] }),
    /inside the project/,
  );
  assert.throws(
    () => addTrigger(st, { workflow: 'x', type: 'git', branch: 'a;b' }),
    /invalid branch/,
  );
  assert.equal(addTrigger(st, { workflow: 'x', type: 'git', cooldownSec: 1 }).cooldownSec, 30); // floor
});

test('globs and untrusted event values', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'));
  assert.ok(globToRegExp('*.json').test('package.json'));
  assert.ok(!globToRegExp('*.json').test('a/package.json'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.equal(cleanValue('a\nb\u0000c\u001b[31m'), 'a b c [31m');
  assert.equal(cleanValue('x'.repeat(500)).length, 300);
});

test('collectDue: schedules advance; triggers set a baseline first, then fire once per change with cooldown', () => {
  const st: SchedulerState = { schedules: [], triggers: [] };
  const t0 = at('2026-11-12T10:00:00');
  const rec = addSchedule(st, { workflow: 'nightly', cron: '0 * * * *' }, t0);
  const once = addSchedule(st, { workflow: 'once', at: '2026-11-12T10:30:00' }, t0);
  let head = 'aaa';
  let files = new Map([['src/a.ts', 1]]);
  addTrigger(st, { workflow: 'on-push', type: 'git', branch: 'main', cooldownSec: 60 });
  addTrigger(st, { workflow: 'on-edit', type: 'file', paths: ['src/**'], cooldownSec: 60 });
  const probes = { head: () => head, scan: () => files };

  assert.deepEqual(collectDue('/w', st, t0, probes), []); // baselines only
  head = 'bbb';
  files = new Map([
    ['src/a.ts', 2],
    ['src/new.ts', 1],
  ]);
  const t1 = at('2026-11-12T11:00:00');
  const due = collectDue('/w', st, t1, probes);
  assert.deepEqual(due.map((d) => d.workflow).sort(), ['nightly', 'on-edit', 'on-push', 'once']);
  assert.equal(rec.next, at('2026-11-12T12:00:00').toISOString());
  assert.equal(once.enabled, false);
  assert.deepEqual(due.find((d) => d.workflow === 'on-push')!.inputs, {
    trigger: 'git',
    branch: 'main',
    commit: 'bbb',
  });
  assert.equal(due.find((d) => d.workflow === 'on-edit')!.inputs.changed, 'src/a.ts, src/new.ts');
  assert.deepEqual(collectDue('/w', st, t1, probes), []); // no change, nothing fires

  // Cooldown: a change right after a run waits for a later tick.
  st.triggers[0].lastRun = { at: t1.toISOString(), result: 'succeeded' };
  head = 'ccc';
  assert.deepEqual(collectDue('/w', st, at('2026-11-12T11:00:30'), probes), []);
  assert.equal(collectDue('/w', st, at('2026-11-12T11:02:00'), probes)[0].workflow, 'on-push');
});

test('scheduler run: a due workflow runs through the broker, audited as agentbelt-scheduler', async () => {
  const repo = tempRepo();
  try {
    const st = loadScheduler(repo.dir);
    addSchedule(st, { workflow: 'repo-health', cron: '* * * * *' }, new Date(Date.now() - 120_000));
    addTrigger(st, { workflow: 'repo-health', type: 'file', paths: ['*.md'] });
    saveScheduler(repo.dir, st);

    const ran = await tick('t', repo.dir, new Date());
    assert.equal(ran.length, 1); // the schedule; the file trigger only took its baseline
    assert.equal(ran[0].result, 'succeeded');

    writeFileSync(join(repo.dir, 'NOTES.md'), 'x');
    const again = await tick('t', repo.dir, new Date());
    assert.deepEqual(
      again.map((r) => r.item.kind),
      ['trigger'],
    );
    assert.equal(again[0].result, 'succeeded'); // undeclared event inputs are not passed

    const audit = readFileSync(join(repo.dir, '.agentbelt', 'audit.jsonl'), 'utf8');
    assert.match(
      audit,
      /"client":"agentbelt-scheduler","kind":"tool","plugin":"workflows","tool":"workflows_start"/,
    );
    const saved = loadScheduler(repo.dir);
    assert.equal(saved.schedules[0].lastRun!.result, 'succeeded');
    assert.equal(saved.triggers[0].lastRun!.result, 'succeeded');
  } finally {
    repo.cleanup();
  }
});

test('CLI: schedule add checks the workflow exists; webhook triggers are refused', () => {
  const repo = tempRepo();
  const cli = (args: string[]) => {
    try {
      return execFileSync(
        process.execPath,
        [
          '--no-deprecation',
          '--conditions=source',
          '--import',
          'tsx',
          'packages/cli/src/cli.ts',
          ...args,
          '--workspace',
          repo.dir,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      return `FAILED ${(e as { stderr?: string }).stderr ?? ''}`;
    }
  };
  try {
    assert.match(
      cli(['schedule', 'add', 'nope', '--cron', '0 9 * * *']),
      /FAILED[\s\S]*no workflow named nope/,
    );
    assert.match(
      cli(['trigger', 'add', 'repo-health', '--on', 'webhook']),
      /FAILED[\s\S]*not offered/,
    );
    cli(['schedule', 'add', 'repo-health', '--cron', '0 9 * * 1-5']);
    assert.match(
      cli(['schedule', 'list']),
      /sch-[0-9a-f]{6}\s+on\s+repo-health\s+cron "0 9 \* \* 1-5"/,
    );
  } finally {
    repo.cleanup();
  }
});
