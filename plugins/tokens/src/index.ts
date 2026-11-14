// Token optimization for the optional coding agent: context compaction (./compact.ts) and a token
// report built from the token counts the model server itself returned for each agent run.
// Nothing here estimates savings: the report compares measured runs with compaction off and on.
import * as z from 'zod';
import { definePlugin, fail, ok } from '@agentbelt/core';

export * from './compact.js';

/** Token usage of one agent run, as reported by the model server (prompt/completion tokens). */
export interface RunTokens {
  id: string;
  at: string;
  model: string;
  task: string;
  status: string;
  steps: number;
  /** Sum of prompt tokens over all model calls in the run. */
  inputTokens: number;
  /** Sum of completion tokens (reasoning included) over all model calls in the run. */
  outputTokens: number;
  /** Largest single prompt: how close the run came to the context window. */
  maxInputTokens: number;
  /** Model calls whose reply carried no usage numbers (their tokens are not in the sums). */
  unreportedCalls: number;
  compaction: {
    enabled: boolean;
    budgetTokens?: number;
    /** Model calls where compaction changed what was sent. */
    compactedCalls: number;
    duplicates: number;
    summarized: number;
    /** Estimate (about 4 chars per token) of what compaction removed; not a measurement. */
    estimatedTokensRemoved: number;
  };
}

const avg = (xs: number[]) =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;

/** Per-run lines plus averages for compaction off and on. */
export function tokensReport(runs: RunTokens[]): string {
  if (!runs.length) return 'No agent runs recorded in this project yet (agent_run records them).';
  const lines = runs.map(
    (r) =>
      `${r.at.slice(0, 19)}  ${r.compaction.enabled ? 'compact' : 'full   '}  in ${r.inputTokens}  out ${r.outputTokens}  max prompt ${r.maxInputTokens}  ${r.steps} step(s)  ${r.status}  ${r.model}  ${r.task.slice(0, 50)}${r.unreportedCalls ? `  (${r.unreportedCalls} call(s) without usage)` : ''}`,
  );
  const group = (enabled: boolean) => {
    const g = runs.filter((r) => r.compaction.enabled === enabled);
    if (!g.length) return `compaction ${enabled ? 'on ' : 'off'}: no runs`;
    return `compaction ${enabled ? 'on ' : 'off'}: ${g.length} run(s), avg input ${avg(g.map((r) => r.inputTokens))}, avg output ${avg(g.map((r) => r.outputTokens))}, avg max prompt ${avg(g.map((r) => r.maxInputTokens))}, completed ${g.filter((r) => r.status === 'completed').length}/${g.length}`;
  };
  return [
    'Measured tokens per agent run (from the model server):',
    ...lines,
    '',
    group(false),
    group(true),
    'Runs of different tasks are not comparable; compare the same task with compaction off and on.',
  ].join('\n');
}

export default definePlugin({
  name: 'tokens',
  version: '0.3.0',
  description:
    'Token report for the optional coding agent: measured input/output tokens per run, with and without context compaction.',
  permissions: { callTools: true },
  tools: [
    {
      name: 'report',
      description:
        'Measured input and output tokens of recent agent_run calls in this project, per run and averaged with context compaction off and on.',
      input: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
      readOnly: true,
      async run({ limit }, ctx) {
        if (!ctx.listTools().includes('agent_runs'))
          return fail(
            'The coding agent is not set up, so there are no runs. The user can set one up with: agentbelt agent setup',
          );
        const r = await ctx.callTool('agent_runs', { limit });
        const runs = (r.data?.runs ?? []) as RunTokens[];
        return ok(tokensReport(runs), { runs });
      },
    },
  ],
});
