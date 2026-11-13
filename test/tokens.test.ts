// Token optimization: context compaction and the token report. No real model: a scripted
// ModelClient reports usage the way an OpenAI-compatible server does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentbeltServer,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelClient,
  type Plugin,
} from '@agentbelt/core';
import agent from '@agentbelt/plugin-agent';
import tokens, {
  COMPACTED,
  compactMessages,
  estimateTokens,
  focusTerms,
  summarizeOutput,
} from '@agentbelt/plugin-tokens';
import { tempRepo } from './helpers.ts';

type ToolMsg = Extract<ChatMessage, { role: 'tool' }>;

/** A conversation: system, task, then `n` read_file calls with the given outputs. */
function conversation(outputs: string[]): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'Do the task.' },
  ];
  outputs.forEach((out, i) => {
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"f${i}.txt"}` },
        },
      ],
    });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: out });
  });
  return msgs;
}

const big = (tag: string, lines = 400) =>
  Array.from({ length: lines }, (_, i) => `${tag} line ${i} ${'x'.repeat(40)}`).join('\n');

test('compaction: under budget nothing changes', () => {
  const msgs = conversation(['small output', big('a', 20)]);
  const r = compactMessages(msgs, { budgetTokens: 1_000_000 });
  assert.deepEqual(r.messages, msgs);
  assert.equal(r.stats.summarized, 0);
});

test('compaction: summarizes old tool results oldest first, keeps prompt, task and recent turns', () => {
  const msgs = conversation([big('a'), big('b'), big('c'), big('d')]);
  const before = structuredClone(msgs);
  const budget = Math.round(estimateTokens(msgs) / 2);
  const r = compactMessages(msgs, { budgetTokens: budget, keepRecent: 2 });
  assert.deepEqual(msgs, before, 'input is not changed');
  assert.equal(r.messages.length, msgs.length, 'no message is dropped');
  assert.deepEqual(r.messages.slice(0, 2), msgs.slice(0, 2));
  assert.deepEqual(r.messages.slice(-2), msgs.slice(-2));
  // Every tool call still has its result, in order.
  r.messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls)
      assert.equal((r.messages[i + 1] as ToolMsg).tool_call_id, m.tool_calls[0].id);
  });
  const contents = r.messages.filter((m) => m.role === 'tool').map((m) => m.content as string);
  assert.ok(contents[0].startsWith(COMPACTED));
  assert.match(contents[0], /read_file \{"path":"f0\.txt"\} was already run; .*\(400 lines\)/);
  assert.equal(contents[3], big('d'));
  assert.ok(r.stats.summarized >= 1);
  assert.ok(r.stats.estimatedAfter <= budget);
  assert.ok(r.stats.estimatedAfter < r.stats.estimatedBefore);
});

test('compaction: summaries keep the lines that mention terms from the task', () => {
  assert.deepEqual(
    focusTerms('Which file defines KEYCHAIN_SERVICE? Read src/model.ts and check `maxTokens`.'),
    ['maxTokens', 'KEYCHAIN_SERVICE', 'src/model.ts'],
  );
  const file = big('a', 200).split('\n');
  file[120] = "export const KEYCHAIN_SERVICE = 'agentbelt-agent';";
  const msgs = conversation([file.join('\n'), big('b'), big('c')]);
  (msgs[1] as { content: string }).content = 'What is KEYCHAIN_SERVICE?';
  const r = compactMessages(msgs, { budgetTokens: 9000, keepRecent: 1 });
  const first = r.messages.find((m) => m.role === 'tool')!.content as string;
  assert.ok(first.startsWith(COMPACTED));
  assert.match(first, /121: export const KEYCHAIN_SERVICE = 'agentbelt-agent';/);
});

test('compaction: a repeated tool result is replaced by a pointer to the newest copy', () => {
  const same = big('same', 30);
  const msgs = conversation([same, 'other', same, 'last']);
  const r = compactMessages(msgs, { budgetTokens: 1_000_000, keepRecent: 1 });
  const tool = r.messages.filter((m) => m.role === 'tool').map((m) => m.content as string);
  assert.match(tool[0], /same output as a later call/);
  assert.equal(tool[2], same);
  assert.equal(r.stats.duplicates, 1);
});

test('compaction: test-log summaries keep error lines; tiny budgets shrink to one line', () => {
  const log = [
    ...Array.from({ length: 100 }, (_, i) => `ok ${i} - passes`),
    'not ok 101 - parses dates',
    '  Error: expected 2 got 3',
    ...Array.from({ length: 100 }, (_, i) => `ok ${200 + i} - passes`),
  ].join('\n');
  const s = summarizeOutput('run_checks {}', log);
  assert.match(s, /not ok 101 - parses dates/);
  assert.match(s, /Error: expected 2 got 3/);
  assert.ok(s.length < log.length / 3);

  const msgs = conversation([log, big('b'), big('c')]);
  const r = compactMessages(msgs, { budgetTokens: 10, keepRecent: 1 });
  const tool = r.messages.filter((m) => m.role === 'tool').map((m) => m.content as string);
  assert.equal(tool[0].split('\n').length, 1);
  assert.equal(tool[2], big('c'));
});

/** Scripted model whose usage numbers are the size of what it was sent (like a real server). */
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
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        usage: { inputTokens: estimateTokens(request.messages), outputTokens: 7 },
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

const reads = () => [
  { toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a.txt' } }] },
  { toolCalls: [{ id: '2', name: 'read_file', arguments: { path: 'b.txt' } }] },
  { toolCalls: [{ id: '3', name: 'read_file', arguments: { path: 'a.txt' } }] },
  { toolCalls: [{ id: '4', name: 'read_file', arguments: { path: 'c.txt' } }] },
  { content: 'All three files are logs.' },
];

test('agent_run: compaction is off by default, on with compact: true; tokens recorded and reported', async () => {
  const repo = tempRepo();
  try {
    for (const f of ['a', 'b', 'c']) writeFileSync(join(repo.dir, `${f}.txt`), big(f, 250));
    const plugins = [agent, tokens as Plugin];
    const off = scripted(reads());
    const s1 = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir, model: off });
    const r1 = await s1.invoke('agent_run', { task: 'Read the files.' });
    assert.equal(r1.isError, undefined, r1.text);
    assert.match(r1.text, /compaction off/);
    // Off: every request carries the full history, nothing compacted.
    for (const req of off.seen)
      assert.ok(!req.messages.some((m) => (m.content ?? '').startsWith(COMPACTED)));

    const on = scripted(reads());
    const s2 = createAgentbeltServer({ version: 't', plugins, workspace: repo.dir, model: on });
    const r2 = await s2.invoke('agent_run', {
      task: 'Read the files.',
      compact: true,
      contextBudget: 3000,
    });
    assert.equal(r2.isError, undefined, r2.text);
    assert.match(r2.text, /compaction on \(budget 3000/);
    const last = on.seen.at(-1)!.messages;
    assert.ok(last.some((m) => (m.content ?? '').startsWith(COMPACTED)));
    // Same task, same replies: the last prompt is smaller with compaction.
    const t1 = (r1.data!.tokens as { maxInputTokens: number; inputTokens: number }).maxInputTokens;
    const t2 = (r2.data!.tokens as { maxInputTokens: number; inputTokens: number }).maxInputTokens;
    assert.ok(t2 < t1, `${t2} < ${t1}`);
    assert.equal((r2.data!.tokens as { outputTokens: number }).outputTokens, 5 * 7);

    const runs = await s2.invoke('agent_runs', {});
    assert.equal((runs.data!.runs as unknown[]).length, 2);
    const report = await s2.invoke('tokens_report', {});
    assert.equal(report.isError, undefined, report.text);
    assert.match(report.text, /compaction off: 1 run\(s\)/);
    assert.match(report.text, /compaction on : 1 run\(s\)/);
  } finally {
    repo.cleanup();
  }
});

test('tokens_report without the agent explains how to set it up', async () => {
  const repo = tempRepo();
  try {
    const s = createAgentbeltServer({
      version: 't',
      plugins: [tokens as Plugin],
      workspace: repo.dir,
    });
    const r = await s.invoke('tokens_report', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /agentbelt agent setup/);
  } finally {
    repo.cleanup();
  }
});
