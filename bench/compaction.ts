// Measures context compaction with a real model: the same tasks with compaction off and on.
// Uses the agent model from `agentbelt agent setup` (e.g. a local Ollama model with a 16k context).
// Token numbers are the server's own prompt/completion counts; nothing is estimated.
//
//   node --conditions=source --import tsx bench/compaction.ts [--reps 3] [--budget 10000]
//     [--model <name>] [--out results.json]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentbeltServer, createModelClient, loadModelConfig } from '@agentbelt/core';
import type { Plugin } from '@agentbelt/core';
import git from '@agentbelt/plugin-git';
import testing from '@agentbelt/plugin-testing';
import agent from '@agentbelt/plugin-agent';
import tokens, { type RunTokens } from '@agentbelt/plugin-tokens';
import { agentConfigFile } from '../packages/cli/src/agent.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const reps = Number(arg('--reps') ?? 3);
const outFile = arg('--out');
const budget = Number(arg('--budget') ?? 10_000);

// A failing test log of ~300 lines (one failure in the middle).
const CHECK_JS = `for (let i = 1; i <= 300; i++) {
  if (i === 147) { console.log('not ok 147 - date parser handles leap years'); console.log('  Error: expected 2024-02-29, got 2024-03-01'); }
  else console.log('ok ' + i + ' - case ' + i + ' passes with the expected output and no warnings');
}
process.exit(1);
`;

const TASKS = [
  {
    id: 'read-5-files',
    task:
      'Read these files one at a time with read_file: src/model.ts, src/sandbox.ts, src/external.ts, ' +
      'src/scheduler.ts, src/server.ts. After reading all five, answer: which file defines the ' +
      'KEYCHAIN_SERVICE constant, and what is its value?',
    correct: /agentbelt-agent/,
  },
  {
    id: 'test-log-twice',
    task:
      'Run the checks with run_checks, then run them a second time to confirm the failure is stable. ' +
      'Then read src/audit.ts. Report the name of the failing test and the file name of the ' +
      'audit log that src/audit.ts writes.',
    correct: /leap(?=[\s\S]*audit\.jsonl)|audit\.jsonl(?=[\s\S]*leap)/i,
  },
];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbelt-bench-'));
  cpSync(join(root, 'packages', 'core', 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'bench', scripts: { test: 'node check.js' } }, null, 2),
  );
  writeFileSync(join(dir, '.gitignore'), '.agentbelt/\n');
  const g = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'bench',
        GIT_AUTHOR_EMAIL: 'bench@example.invalid',
        GIT_COMMITTER_NAME: 'bench',
        GIT_COMMITTER_EMAIL: 'bench@example.invalid',
      },
    });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  return dir;
}

const config = loadModelConfig(agentConfigFile());
if (!config) throw new Error('no agent model configured; run: agentbelt agent setup');
// --model picks another model on the same endpoint (e.g. a 32k-context variant).
const model = createModelClient(
  { ...config, model: arg('--model') ?? config.model },
  { timeoutMs: 600_000 },
);
const plugins = [git, testing, agent, tokens] as Plugin[];

const results: {
  task: string;
  compact: boolean;
  rep: number;
  correct: boolean;
  ms: number;
  tools: string[];
  answer: string | null;
  tokens: RunTokens;
}[] = [];
// --task <id> and --mode off|on run a subset (e.g. re-run one run, or compare models quickly).
const onlyTask = arg('--task');
const onlyMode = arg('--mode');
for (let rep = 1; rep <= reps; rep++)
  // Alternate which mode goes first so warm caches don't favour one side.
  for (const t of TASKS.filter((x) => !onlyTask || x.id === onlyTask))
    for (const compact of (rep % 2 ? [false, true] : [true, false]).filter(
      (c) => !onlyMode || (onlyMode === 'on') === c,
    )) {
      const dir = fixture();
      try {
        const s = createAgentbeltServer({ version: 'bench', plugins, workspace: dir, model });
        const started = Date.now();
        const r = await s.invoke('agent_run', {
          task: t.task,
          maxSteps: 15,
          compact,
          contextBudget: budget,
        });
        const d = r.data as {
          answer: string | null;
          tokens: RunTokens;
          toolCalls: { name: string; ok: boolean }[];
        };
        const row = {
          task: t.id,
          compact,
          rep,
          correct: t.correct.test(d.answer ?? ''),
          ms: Date.now() - started,
          tools: d.toolCalls.map((c) => `${c.name}${c.ok ? '' : '!'}`),
          answer: d.answer,
          tokens: d.tokens,
        };
        results.push(row);
        console.log(
          JSON.stringify({
            task: row.task,
            compact,
            rep,
            status: d.tokens.status,
            correct: row.correct,
            in: d.tokens.inputTokens,
            out: d.tokens.outputTokens,
            maxPrompt: d.tokens.maxInputTokens,
            steps: d.tokens.steps,
            s: Math.round(row.ms / 1000),
          }),
        );
        if (outFile)
          writeFileSync(
            outFile,
            `${JSON.stringify({ model: model.model, budget, reps, results }, null, 2)}\n`,
          );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
