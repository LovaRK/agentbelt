// Optional coding agent: model client, agent loop through the broker, and `agentbelt agent`.
// No real model or network: the endpoint is a fake fetch or a scripted ModelClient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import {
  checkModelConfig,
  createAgentbeltServer,
  createModelClient,
  definePlugin,
  ok,
  type ChatRequest,
  type ChatResult,
  type ModelClient,
  type Plugin,
} from '@agentbelt/core';
import agent from '@agentbelt/plugin-agent';
import { tempRepo } from './helpers.ts';

const plugins = async (): Promise<Plugin[]> => [
  (await import('@agentbelt/plugin-git')).default as Plugin,
  (await import('@agentbelt/plugin-testing')).default as Plugin,
  agent,
];

/** A model that replays scripted replies and records what it was sent. */
function scripted(replies: Partial<ChatResult>[]): ModelClient & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    model: 'fake-model',
    endpoint: '127.0.0.1:1',
    seen,
    async chat(request) {
      seen.push(structuredClone(request));
      const r = replies.shift() ?? { content: 'done' };
      const toolCalls = r.toolCalls ?? [];
      return {
        content: r.content ?? null,
        toolCalls,
        finishReason: r.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: { inputTokens: 10, outputTokens: 5 },
        assistantMessage: {
          role: 'assistant',
          content: r.content ?? null,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
          })),
        },
      };
    },
  };
}

test('model config: loopback only unless remote is enabled; https and no URL credentials', () => {
  const base = { provider: 'custom' as const, model: 'm' };
  assert.equal(checkModelConfig({ ...base, baseUrl: 'http://127.0.0.1:11434/v1' }), null);
  assert.match(checkModelConfig({ ...base, baseUrl: 'https://api.example.com/v1' })!, /remote/);
  assert.equal(
    checkModelConfig({ ...base, baseUrl: 'https://api.example.com/v1', allowRemote: true }),
    null,
  );
  assert.match(
    checkModelConfig({ ...base, baseUrl: 'http://api.example.com/v1', allowRemote: true })!,
    /https/,
  );
  assert.match(
    checkModelConfig({ ...base, baseUrl: `https://u:p${'@'}x.example/v1`, allowRemote: true })!,
    /credentials/,
  );
  assert.match(checkModelConfig({ ...base, baseUrl: 'file:///etc/passwd' })!, /protocol/);
});

test('model client: OpenAI-compatible request, key only in the header, tool calls parsed', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                { id: 'a', function: { name: 'read_file', arguments: '{"path":"x"}' } },
                { id: 'b', function: { name: 'read_file', arguments: '{oops' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const client = createModelClient(
    {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      key: { service: 's', account: 'a' },
      allowRemote: true,
    },
    { fetchImpl: fakeFetch, secret: () => 'sk-test-123' },
  );
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(sent[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    (sent[0].init.headers as Record<string, string>).Authorization,
    'Bearer sk-test-123',
  );
  assert.equal(sent[0].init.redirect, 'error');
  assert.doesNotMatch(String(sent[0].init.body), /sk-test/);
  assert.equal(JSON.parse(String(sent[0].init.body)).model, 'deepseek-chat');
  assert.deepEqual(r.toolCalls[0], { id: 'a', name: 'read_file', arguments: { path: 'x' } });
  assert.match(r.toolCalls[1].error!, /invalid JSON/);
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 3 });

  const noKey = createModelClient(
    {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'm',
      key: { service: 's', account: 'a' },
      allowRemote: true,
    },
    { fetchImpl: fakeFetch, secret: () => null },
  );
  await assert.rejects(noKey.chat({ messages: [] }), /no API key in the keychain/);
});

test('agent_run: the model works only through broker tools; read-only unless write: true', async () => {
  const repo = tempRepo();
  try {
    const model = scripted([
      { toolCalls: [{ id: '1', name: 'list_files', arguments: { dir: '.' } }] },
      { toolCalls: [{ id: '2', name: 'read_file', arguments: { path: 'package.json' } }] },
      { toolCalls: [{ id: '3', name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }] },
      { toolCalls: [{ id: '4', name: 'run_checks', arguments: {} }] },
      { content: 'The project has a test script and it passes.' },
    ]);
    const { invoke } = createAgentbeltServer({
      version: 't',
      plugins: await plugins(),
      workspace: repo.dir,
      model,
    });
    const r = await invoke('agent_run', { task: 'Check the project.' });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /status: completed after 5 step/);
    assert.match(r.text, /write_file \(error\)/); // not offered without write: true
    assert.ok(!existsSync(join(repo.dir, 'x.txt')));
    const toolNames = model.seen[0].tools!.map((t) => t.function.name);
    assert.deepEqual(toolNames.sort(), ['git_diff', 'list_files', 'read_file', 'run_checks']);
    // Tool results went back to the model.
    const msgs = model.seen[2].messages;
    assert.match(String((msgs.at(-1) as { content: string }).content), /"name": "demo"/);
    assert.match(String((model.seen[4].messages.at(-1) as { content: string }).content), /PASS/);

    const audit = readFileSync(join(repo.dir, '.agentbelt', 'audit.jsonl'), 'utf8');
    assert.equal(audit.match(/"kind":"model"/g)!.length, 5);
    assert.match(audit, /fake-model @ 127\.0\.0\.1:1/);
    assert.match(audit, /"tool":"testing_run_checks","detail":"via agent/);
  } finally {
    repo.cleanup();
  }
});

test('agent_run with write: true edits files, but the broker still protects .git', async () => {
  const repo = tempRepo();
  try {
    const model = scripted([
      {
        toolCalls: [
          { id: '1', name: 'write_file', arguments: { path: 'notes.md', content: 'hi\n' } },
        ],
      },
      {
        toolCalls: [
          { id: '2', name: 'write_file', arguments: { path: '.git/config', content: 'x' } },
        ],
      },
      { content: 'Wrote notes.md.' },
    ]);
    const { invoke } = createAgentbeltServer({
      version: 't',
      plugins: await plugins(),
      workspace: repo.dir,
      model,
    });
    const r = await invoke('agent_run', { task: 'Add notes.', write: true });
    assert.match(r.text, /status: completed/);
    assert.equal(readFileSync(join(repo.dir, 'notes.md'), 'utf8'), 'hi\n');
    assert.doesNotMatch(readFileSync(join(repo.dir, '.git', 'config'), 'utf8'), /^x$/);
    assert.match(
      String((model.seen[2].messages.at(-1) as { content: string }).content),
      /ERROR: denied/,
    );
  } finally {
    repo.cleanup();
  }
});

test('bounded: repeated errors stop the loop; no model configured gives a setup hint', async () => {
  const repo = tempRepo();
  try {
    const model = scripted([
      { toolCalls: [{ id: '1', name: 'nope', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'nope', arguments: {} }] },
      { toolCalls: [{ id: '3', name: 'nope', arguments: {} }] },
    ]);
    const s = createAgentbeltServer({
      version: 't',
      plugins: await plugins(),
      workspace: repo.dir,
      model,
    });
    const r = await s.invoke('agent_run', { task: 't' });
    assert.equal(r.isError, true);
    assert.match(r.text, /too_many_errors after 3 step/);

    const none = createAgentbeltServer({
      version: 't',
      plugins: await plugins(),
      workspace: repo.dir,
    });
    assert.match((await none.invoke('agent_run', { task: 't' })).text, /agentbelt agent setup/);
  } finally {
    repo.cleanup();
  }
});

test('only plugins with the model permission can use the model', async () => {
  const repo = tempRepo();
  try {
    const sneaky = definePlugin({
      name: 'sneaky',
      version: '1',
      description: 'no model permission',
      permissions: { read: true },
      tools: [
        {
          name: 'ask',
          description: 'x',
          input: z.object({}),
          async run(_a, ctx) {
            await ctx.model!.chat({ messages: [{ role: 'user', content: 'hi' }] });
            return ok('asked');
          },
        },
      ],
    });
    const model = scripted([]);
    const s = createAgentbeltServer({
      version: 't',
      plugins: [sneaky],
      workspace: repo.dir,
      model,
    });
    assert.match((await s.invoke('sneaky_ask', {})).text, /denied: sneaky has no model permission/);
    assert.equal(model.seen.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('agentbelt agent setup: remote needs opt-in; config is private and holds no key', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbelt-agent-'));
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
          'agent',
          ...args,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AGENTBELT_HOME: home },
        },
      );
    } catch (e) {
      const err = e as { stderr?: string };
      return `FAILED ${err.stderr ?? ''}`;
    }
  };
  try {
    const remote = cli([
      'setup',
      '--provider',
      'custom',
      '--base-url',
      'https://llm.example.com/v1',
      '--model',
      'm',
      '--yes',
    ]);
    assert.match(remote, /FAILED[\s\S]*--allow-remote/);
    assert.ok(!existsSync(join(home, 'agent-model.json')));

    cli(['setup', '--provider', 'local', '--model', 'qwen-coder', '--yes']);
    const file = join(home, 'agent-model.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(config, {
      provider: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen-coder',
    });
    // status/remove print to stderr; check the effect.
    cli(['remove']);
    assert.ok(!existsSync(file));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
