import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contextView,
  createAgentbeltServer,
  discoverModels,
  fromClaudeStatusline,
  parseOllamaShow,
  ProjectState,
  readContext,
  recordContext,
  route,
  type ModelRegistry,
} from '@agentbelt/core';
import testing from '@agentbelt/plugin-testing';
import { tempRepo } from './helpers.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// Runs from the repo (so tsx resolves) against the given project with --workspace.
const cli = (workspace: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    [
      '--conditions=source',
      '--import',
      'tsx',
      join(root, 'packages/cli/src/cli.ts'),
      ...args,
      '--workspace',
      workspace,
    ],
    { cwd: root, encoding: 'utf8' },
  );

test('state persists, renders the Markdown files, and VERIFIED needs evidence', () => {
  const repo = tempRepo();
  try {
    const ps = new ProjectState(repo.dir, 'demo');
    ps.upsert({ id: 'M1', title: 'Core', criteria: 'tests pass' });
    ps.upsert({ id: 'M2', title: 'Plugins', dependsOn: ['M1'] });
    ps.setStatus('M1', 'IN_PROGRESS');
    assert.throws(() => ps.setStatus('M1', 'VERIFIED'), /without evidence/);
    assert.equal(new ProjectState(repo.dir).load().items[0].status, 'IN_PROGRESS'); // rejected change not saved
    ps.setStatus('M1', 'VERIFIED', {
      evidence: 'npm test: 16/16',
      files: ['src/a.ts'],
      tests: ['npm test'],
    });
    const s = new ProjectState(repo.dir).load(); // a new process would see the same
    assert.equal(s.items[0].status, 'VERIFIED');
    assert.equal(s.current.next, 'M2'); // dependencies satisfied
    for (const f of [
      'MASTER_PLAN.md',
      'PROGRESS.md',
      'CURRENT_STATE.md',
      'DECISIONS.md',
      'BLOCKERS.md',
      'HANDOFF.md',
      'execution-history.jsonl',
    ])
      assert.ok(existsSync(join(repo.dir, '.agentbelt', f)), f);
    assert.match(
      readFileSync(join(repo.dir, '.agentbelt', 'PROGRESS.md'), 'utf8'),
      /\| M1 \| Core \| VERIFIED \|/,
    );
    // MASTER_PLAN.md is never overwritten once a person edits it.
    writeFileSync(join(repo.dir, '.agentbelt', 'MASTER_PLAN.md'), '# mine\n');
    ps.decide('Use MCP', 'one server for all clients', 'portability');
    assert.equal(readFileSync(join(repo.dir, '.agentbelt', 'MASTER_PLAN.md'), 'utf8'), '# mine\n');
    assert.match(readFileSync(join(repo.dir, '.agentbelt', 'DECISIONS.md'), 'utf8'), /D1 Use MCP/);
    // Secrets and home paths never reach state files.
    ps.block(`token=${'ghp'}_${'x1'.repeat(20)} in ${process.env.HOME}/x`);
    const blockers = readFileSync(join(repo.dir, '.agentbelt', 'BLOCKERS.md'), 'utf8');
    assert.doesNotMatch(blockers, /ghp_|\/Users\//);
  } finally {
    repo.cleanup();
  }
});

test('recovers from an interrupted write using the last good copy', () => {
  const repo = tempRepo();
  try {
    const ps = new ProjectState(repo.dir);
    ps.upsert({ id: 'M1', title: 'Core' });
    ps.upsert({ id: 'M2', title: 'Next' });
    writeFileSync(ps.file, '{ "schemaVersion": 1, "ite'); // truncated by a crash
    const s = ps.load();
    assert.deepEqual(
      s.items.map((i) => i.id),
      ['M1'],
    ); // from project.json.bak
    ps.upsert({ id: 'M3', title: 'After recovery' });
    assert.deepEqual(
      new ProjectState(repo.dir).load().items.map((i) => i.id),
      ['M1', 'M3'],
    );
  } finally {
    repo.cleanup();
  }
});

test('concurrent writers from separate processes lose no updates; stale locks are taken over', async () => {
  const repo = tempRepo();
  try {
    const ps = new ProjectState(repo.dir);
    ps.upsert({ id: 'M1', title: 'Shared' });
    writeFileSync(join(ps.dir, 'project.lock'), '999999 2020-01-01'); // left by a dead process
    const writer = (n: number) =>
      new Promise<number>((resolve) => {
        const c = spawn(
          process.execPath,
          [
            '--conditions=source',
            '--import',
            'tsx',
            '-e',
            `import('@agentbelt/core').then(({ ProjectState }) => { const p = new ProjectState(${JSON.stringify(repo.dir)}); for (let i = 0; i < 5; i++) p.upsert({ id: 'M${n}.' + (i + 1), title: 'w${n}-' + i }); })`,
          ],
          { cwd: root, stdio: 'ignore' },
        );
        c.on('exit', (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all([2, 3, 4].map(writer));
    assert.deepEqual(codes, [0, 0, 0]);
    assert.equal(new ProjectState(repo.dir).load().items.length, 1 + 15);
  } finally {
    repo.cleanup();
  }
});

test('context: unknown stays UNKNOWN; 80% used warns once and checkpoints with a handoff', () => {
  const repo = tempRepo();
  try {
    assert.equal(contextView(readContext(repo.dir)).used, 'UNKNOWN');
    const none = fromClaudeStatusline({ model: { id: 'claude-x' } });
    assert.equal(none.used, null);
    assert.equal(contextView({ ...none, at: '' }).remainingPercent, 'UNKNOWN');
    const ps = new ProjectState(repo.dir);
    ps.upsert({ id: 'M1', title: 'Core' });
    const low = recordContext(repo.dir, {
      client: 'claude-code',
      model: 'm',
      limit: 200_000,
      used: 100_000,
      source: 'test',
    });
    assert.equal(low.warning, false);
    assert.equal(low.remainingPercent, '50%');
    const high = recordContext(
      repo.dir,
      fromClaudeStatusline({
        model: { id: 'm' },
        context_window: { context_window_size: 200_000, used_percentage: 85 },
      }),
    );
    assert.equal(high.warning, true);
    assert.equal(high.remaining, 30_000);
    const checkpoints = ps.load().checkpoints;
    assert.equal(checkpoints.length, 1);
    assert.match(checkpoints[0].note, /context 15% left/);
    recordContext(repo.dir, {
      client: 'claude-code',
      model: 'm',
      limit: 200_000,
      used: 175_000,
      source: 'test',
    });
    assert.equal(ps.load().checkpoints.length, 1); // no repeat warning while still above
    assert.throws(
      () => recordContext(repo.dir, { client: 'c', model: null, limit: -1, used: 1, source: 't' }),
      /invalid limit/,
    );
  } finally {
    repo.cleanup();
  }
});

const SHOW = `  Model
    architecture        gpt-oss
    context length      131072

  Capabilities
    completion
    tools
    thinking
        levels     low, medium, high

  Parameters
    num_ctx        16384
`;

test('model discovery parses ollama output (test doubles) and routing checks capabilities', async () => {
  assert.deepEqual(parseOllamaShow(SHOW), {
    maxContext: 131072,
    configuredContext: 16384,
    capabilities: ['completion', 'tools', 'thinking'],
  });
  const runner = (cmd: string, args: string[]) => {
    if (args[0] === 'list')
      return 'NAME  ID  SIZE  MODIFIED\nbig-tools:latest    1    13 GB    now\nsmall:1b    2    1.0 GB    now\nhuge:400b    3    400 GB    now\n';
    if (args[0] === 'ps') return 'NAME  ID\nsmall:1b    2\n';
    if (args[0] === 'show' && args[1] === 'big-tools:latest') return SHOW;
    if (args[0] === 'show' && args[1] === 'small:1b')
      return '  Model\n    context length      8192\n\n  Capabilities\n    completion\n\n  Parameters\n    num_ctx        8192\n';
    if (args[0] === 'show')
      return '  Model\n    context length      262144\n\n  Capabilities\n    completion\n    tools\n';
    return null;
  };
  const reg = await discoverModels(runner, async () => {
    throw new Error('not running');
  }, ['big-tools:latest']);
  assert.equal(reg.providers.lmstudio, 'not running');
  assert.deepEqual(
    reg.models.map((m) => [m.name, m.running]),
    [
      ['big-tools:latest', false],
      ['small:1b', true],
      ['huge:400b', false],
    ],
  );
  assert.equal(reg.models[2].fitsInMemory, false);
  // No num_ctx configured: the model's maximum is not assumed (huge:400b also doesn't fit).
  assert.equal(reg.models[2].configuredContext, null);

  assert.equal(route('deterministic', reg).target, 'none');
  const analysis = route('code-analysis', reg); // needs tools: the running model has none
  assert.equal(analysis.model, 'big-tools:latest');
  assert.equal(route('test-summary', reg).model, 'small:1b'); // no tools needed: running one first
  const arch = route('architecture', reg);
  assert.equal(arch.target, 'user-selected'); // never chosen automatically
  assert.match(arch.reason, /never sends project code to a cloud model/);
  assert.equal(route('high-risk-change', reg).verificationRequired, true);
  const empty: ModelRegistry = { ...reg, models: [] };
  assert.equal(route('code-analysis', empty).target, 'user-selected'); // fallback, no silent cloud
  const noOllama = await discoverModels(
    () => null,
    async () => {
      throw new Error('x');
    },
  );
  assert.equal(noOllama.providers.ollama, 'not installed');
});

test('MCP: project_get_status, handoff, and update_task (VERIFIED requires an audit reference)', async () => {
  const repo = tempRepo();
  try {
    new ProjectState(repo.dir).upsert({ id: 'M5', title: 'Testing plugin' });
    const s = createAgentbeltServer({ version: '9.9.9', plugins: [testing], workspace: repo.dir });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = (s.server as any)._registeredTools[name];
      return tool.handler(args, {});
    };
    assert.match(
      (await call('project_get_status')).content[0].text,
      /AGENTBELT PROJECT STATUS[\s\S]*Not started: 1/,
    );
    assert.match(
      (await call('project_get_handoff')).content[0].text,
      /# Handoff[\s\S]*Git: branch main/,
    );
    const bad = await call('project_update_task', {
      id: 'M5',
      status: 'VERIFIED',
      evidence: 'trust me',
    });
    assert.equal(bad.isError, true);
    await s.invoke('testing_run_checks', {});
    const ts = readFileSync(join(repo.dir, '.agentbelt', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.tool === 'testing_run_checks').ts;
    const good = await call('project_update_task', {
      id: 'M5',
      status: 'VERIFIED',
      evidence: 'checks pass',
      auditRef: ts,
    });
    assert.equal(good.isError, false, good.content[0].text);
    assert.match(
      new ProjectState(repo.dir).load().items[0].evidence[0].text,
      /\[audit .* testing_run_checks by unknown\]/,
    );
  } finally {
    repo.cleanup();
  }
});

test('CLI: progress init, status and resume', () => {
  const repo = tempRepo();
  try {
    assert.equal(cli(repo.dir, 'progress', 'init', '--name', 'demo').status, 0);
    assert.notEqual(cli(repo.dir, 'progress', 'set', 'M0', 'VERIFIED').status, 0); // no evidence
    assert.equal(
      cli(repo.dir, 'progress', 'set', 'M0', 'VERIFIED', '--evidence', 'audit done').status,
      0,
    );
    assert.equal(cli(repo.dir, 'progress', 'set', 'M1', 'IN_PROGRESS').status, 0);
    const status = cli(repo.dir, 'status').stdout;
    assert.match(status, /Verified: 1\/13/);
    assert.match(status, /M1 — Core MCP server \(IN_PROGRESS\)/);
    assert.match(status, /Context:\n {2}UNKNOWN/);
    const resume = cli(repo.dir, 'resume').stdout;
    assert.match(resume, /Interrupted \(IN_PROGRESS\): M1 Core MCP server/);
    assert.match(resume, /Last verified: M0 Repository inspection — audit done/);
    assert.match(resume, /clean working tree|uncommitted/);
  } finally {
    repo.cleanup();
  }
});
