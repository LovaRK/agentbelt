import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentbeltServer } from '@agentbelt/core';
import git from '@agentbelt/plugin-git';
import testing, { excerpt } from '@agentbelt/plugin-testing';
import workflows, { decide, execute, getRun } from '@agentbelt/plugin-workflows';
import { tempRepo } from './helpers.ts';

const plugins = [git, testing, workflows];

test('git: status, log, and changes isolated in a task branch', async () => {
  const repo = tempRepo();
  try {
    const { invoke } = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir });
    assert.match((await invoke('git_status', {})).text, /## main/);
    assert.match((await invoke('git_log', {})).text, /init/);
    const started = await invoke('git_task_start', { name: 'add-readme' });
    const task = started.data!.task as string;
    assert.match(task, /^add-readme-[0-9a-f]{6}$/);
    writeFileSync(join(started.data!.path as string, 'README.md'), '# demo\n');
    assert.match((await invoke('git_status', { task })).text, /README\.md/);
    assert.match((await invoke('git_diff', { task })).text, /no changes|README/); // untracked
    const commit = await invoke('git_commit', { task, message: 'docs: add README' });
    assert.equal(commit.isError, undefined, commit.text);
    assert.match(commit.text, new RegExp(`on agentbelt/${task}`));
    // main and the user's checkout are untouched.
    assert.equal(repo.git('log', '--oneline', 'main').trim().split('\n').length, 1);
    assert.match(repo.git('log', '--oneline', `agentbelt/${task}`), /docs: add README/);
    assert.match((await invoke('git_tasks', {})).text, new RegExp(task));
    assert.match(
      (await invoke('git_commit', { task, message: 'again' })).text,
      /nothing to commit/,
    );
    assert.match((await invoke('git_commit', { task: 'nope', message: 'x' })).text, /no task nope/);
  } finally {
    repo.cleanup();
  }
});

test('testing: detects and runs project checks, reporting failures', async () => {
  const repo = tempRepo({ test: 'node check.js', lint: 'node lint.js' });
  try {
    writeFileSync(
      join(repo.dir, 'lint.js'),
      "console.error('lint: 2 problems'); process.exit(1);\n",
    );
    const { invoke } = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir });
    const detected = await invoke('testing_detect', {});
    assert.match(detected.text, /lint: npm run lint\ntest: npm test/);
    const r = await invoke('testing_run_checks', {});
    assert.equal(r.data!.passed, false);
    assert.match(r.text, /FAIL {2}lint/);
    assert.match(r.text, /PASS {2}test/);
    assert.match(r.text, /lint: 2 problems/);
    const onlyTest = await invoke('testing_run_checks', { only: ['test'] });
    assert.equal(onlyTest.data!.passed, true);
  } finally {
    repo.cleanup();
  }
});

/** A 300-line TAP log whose only failure, `not ok 147`, sits in the middle. */
function tapLog(): string {
  const lines = ['TAP version 13'];
  for (let n = 1; lines.length < 300 - 8; n++) {
    if (n === 147) {
      lines.push('not ok 147 - parses an empty config file');
      lines.push('  ---');
      lines.push("  error: 'Expected values to be strictly equal'");
      lines.push('  ...');
    } else lines.push(`ok ${n} - case ${n}`);
  }
  lines.push('1..292', '# tests 292', '# pass 291', '# fail 1', '# skipped 0', '# todo 0');
  lines.push('# duration_ms 812', 'npm error Test failed.');
  return lines.join('\n');
}

test('testing: excerpt keeps a mid-log failure, the tail and line numbers under a cap', () => {
  const log = tapLog();
  const total = log.split('\n').length;
  assert.equal(total, 300);
  const notOkLine = log.split('\n').indexOf('not ok 147 - parses an empty config file') + 1;
  assert.ok(notOkLine > 100 && notOkLine < 200, `failure at line ${notOkLine}`);
  const tailOnly = log.split('\n').slice(-60).join('\n');
  assert.doesNotMatch(tailOnly, /not ok 147/); // what the old tail showed

  const out = excerpt(log);
  assert.match(
    out,
    new RegExp(`^ *${notOkLine}\\| not ok 147 - parses an empty config file$`, 'm'),
  );
  assert.match(out, /Expected values to be strictly equal/); // context after the failure
  assert.match(out, /^ *300\| npm error Test failed\.$/m); // the tail
  assert.match(out, /^\[300 lines; showing \d+: 1 of 1 failure-like lines/);
  assert.match(out, /… \d+ lines omitted \(1–\d+\) …/);
  assert.ok(out.split('\n').length <= 1 + 60 + 40 + 3, 'stays under the size cap');

  // Short output is returned whole, unnumbered.
  assert.equal(excerpt('a\nError: b\n'), 'a\nError: b');
  // Many failures: bounded, and says how many were not shown.
  const noisy = Array.from({ length: 500 }, (_, i) => (i % 5 ? `ok ${i}` : `not ok ${i}`)).join(
    '\n',
  );
  const capped = excerpt(noisy);
  assert.ok(capped.split('\n').length <= 1 + 60 + 40 + 40, String(capped.split('\n').length));
  assert.match(capped, /showing \d+: \d+ of 92 failure-like lines/);
  // Very long lines are cut.
  assert.ok(excerpt('x'.repeat(5000)).length < 400);
});

test('testing: run_checks shows a failure from the middle of a long log', async () => {
  const repo = tempRepo({ test: 'node tap.js' });
  try {
    writeFileSync(join(repo.dir, 'tap.log'), tapLog() + '\n');
    writeFileSync(
      join(repo.dir, 'tap.js'),
      "process.stdout.write(require('fs').readFileSync('tap.log', 'utf8')); process.exit(1);\n",
    );
    const { invoke } = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir });
    const r = await invoke('testing_run_checks', { only: ['test'] });
    assert.equal(r.data!.passed, false);
    assert.match(r.text, /FAIL {2}test/);
    assert.match(r.text, /\| not ok 147 - parses an empty config file/);
    assert.match(r.text, /# fail 1/);
  } finally {
    repo.cleanup();
  }
});

test('workflows: bundled and project workflows; approval gate decided outside the tools', async () => {
  const repo = tempRepo();
  try {
    const server = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir });
    const { invoke } = server;
    assert.match((await invoke('workflows_list', {})).text, /safe-commit/);

    const health = await invoke('workflows_start', { name: 'repo-health' });
    assert.match(health.text, /succeeded/);
    assert.equal(health.data!.state, 'succeeded');

    // safe-commit: checks → diff → approval → commit
    const task = (await invoke('git_task_start', { name: 'fix' })).data!.task as string;
    writeFileSync(join(repo.dir, '.agentbelt', 'worktrees', task, 'fix.txt'), 'fixed\n');
    const started = await invoke('workflows_start', {
      name: 'safe-commit',
      inputs: { task, message: 'fix: the thing' },
    });
    assert.equal(started.data!.state, 'waiting_approval', started.text);
    assert.match(started.text, /agentbelt approve/);
    // There is no MCP tool that approves.
    assert.ok(!server.toolIds().some((id) => /approve|reject/.test(id)));

    // The user approves (what `agentbelt approve` does), and the run continues to the commit.
    const ctx = await server.contextFor('workflows');
    const run = getRun(ctx, started.data!.runId as string)!;
    decide(run, 'review', true, 'looks good');
    const done = await execute(ctx, run, ctx.listTools());
    assert.equal(done.state, 'succeeded');
    assert.match(repo.git('log', '--oneline', `agentbelt/${task}`), /fix: the thing/);

    // Project workflows override and validate against installed tools.
    mkdirSync(join(repo.dir, '.agentbelt', 'workflows'), { recursive: true });
    writeFileSync(
      join(repo.dir, '.agentbelt', 'workflows', 'bad.json'),
      JSON.stringify({ name: 'bad', steps: [{ id: 'x', uses: 'shell_rm' }] }),
    );
    assert.match(
      (await invoke('workflows_start', { name: 'bad' })).text,
      /shell_rm is not installed/,
    );
    assert.match((await invoke('workflows_runs', {})).text, /safe-commit/);
  } finally {
    repo.cleanup();
  }
});
