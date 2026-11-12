import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { checkWorkspace, createAgentbeltServer, definePlugin, ok } from '@agentbelt/core';
import { tempRepo } from './helpers.ts';

const probe = definePlugin({
  name: 'probe',
  version: '0.0.1',
  description: 'test plugin with deliberately small permissions',
  permissions: { exec: ['git'], read: true },
  tools: [
    {
      name: 'run',
      description: 'runs a command',
      input: z.object({ program: z.string(), args: z.array(z.string()) }),
      async run({ program, args }, ctx) {
        const r = await ctx.exec(program, args);
        return ok(r.stdout, { exitCode: r.exitCode });
      },
    },
    {
      name: 'read',
      description: 'reads a file',
      input: z.object({ path: z.string() }),
      async run({ path }, ctx) {
        return ok(await ctx.readFile(path));
      },
    },
    {
      name: 'write',
      description: 'writes a file',
      input: z.object({ path: z.string() }),
      async run({ path }, ctx) {
        await ctx.writeFile(path, 'x');
        return ok('written');
      },
    },
    {
      name: 'call',
      description: 'calls another tool',
      input: z.object({}),
      async run(_a, ctx) {
        return ctx.callTool('probe_read', { path: 'package.json' });
      },
    },
  ],
});

test('the broker enforces each permission at call time and audits denials', async () => {
  const repo = tempRepo();
  try {
    const { invoke } = createAgentbeltServer({
      version: 't',
      plugins: [probe],
      workspace: repo.dir,
    });
    // Granted: git, read.
    assert.match(
      (await invoke('probe_run', { program: 'git', args: ['status'] })).text,
      /On branch main/,
    );
    assert.match((await invoke('probe_read', { path: 'package.json' })).text, /"demo"/);
    // Not granted: other programs, writes, calling tools.
    const npm = await invoke('probe_run', { program: 'npm', args: ['test'] });
    assert.equal(npm.isError, true);
    assert.match(npm.text, /probe may not run npm/);
    assert.match((await invoke('probe_write', { path: 'a.txt' })).text, /no write permission/);
    assert.match((await invoke('probe_call', {})).text, /may not call other tools/);
    // Granted program, but the core command policy still applies.
    assert.match(
      (await invoke('probe_run', { program: 'git', args: ['push'] })).text,
      /git push is not allowed/,
    );
    assert.match(
      (await invoke('probe_run', { program: 'git', args: ['-c', 'x=y', 'status'] })).text,
      /global options/,
    );
    // Paths stay inside the workspace and out of .git / .agentbelt.
    assert.match(
      (await invoke('probe_read', { path: '../../etc/passwd' })).text,
      /outside workspace/,
    );
    assert.match((await invoke('probe_read', { path: '.git/config' })).text, /\.git/);
    assert.match(
      (await invoke('probe_read', { path: '.agentbelt/audit.jsonl' })).text,
      /\.agentbelt/,
    );
    // Invalid arguments never reach the tool.
    assert.match((await invoke('probe_read', { path: 5 })).text, /invalid arguments/);

    const audit = readFileSync(join(repo.dir, '.agentbelt', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const denied = audit.filter((e) => e.kind === 'denied');
    assert.ok(denied.length >= 7, `denials audited: ${denied.length}`);
    const exec = audit.find((e) => e.kind === 'exec');
    assert.equal(exec.isolation, 'policy-only'); // never described as a sandbox
  } finally {
    repo.cleanup();
  }
});

test('the workspace is never the home directory or /', () => {
  assert.match(checkWorkspace(homedir())!, /refusing/);
  assert.match(checkWorkspace('/')!, /refusing/);
  assert.equal(checkWorkspace(process.cwd()), null);
});

test('secrets in tool output are redacted before the model sees them', async () => {
  const repo = tempRepo();
  try {
    const leak = definePlugin({
      name: 'leak',
      version: '0',
      description: '',
      permissions: {},
      tools: [
        {
          name: 'say',
          description: '',
          input: z.object({}),
          async run() {
            return ok(`token=${'ghp'}_${'a1'.repeat(20)}`); // built at runtime so the source holds no token
          },
        },
      ],
    });
    const { invoke } = createAgentbeltServer({
      version: 't',
      plugins: [leak],
      workspace: repo.dir,
    });
    const r = await invoke('leak_say', {});
    assert.doesNotMatch(r.text, /ghp_/);
  } finally {
    repo.cleanup();
  }
});
