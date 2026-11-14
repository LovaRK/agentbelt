// Workflows plugin: multi-step recipes over the other plugins' tools, with approval gates.
// Bundled workflows ship in this package (bundled.ts); your own go in <project>/.agentbelt/workflows/*.json.
// Runs are started by the user (through their AI app or the CLI); approvals happen in the CLI.
import { definePlugin, fail, ok, type PluginContext } from '@agentbelt/core';
import * as z from 'zod';
import { BUNDLED } from './bundled.js';
import {
  createRun,
  describe,
  execute,
  getRun,
  listRuns,
  type WorkflowDefinition,
} from './engine.js';

export * from './engine.js';

export { BUNDLED };
const USER_DIR = '.agentbelt/workflows';
/** Project workflows first (they override bundled ones of the same name), then bundled. */
export async function loadWorkflows(ctx: PluginContext): Promise<WorkflowDefinition[]> {
  const own: WorkflowDefinition[] = [];
  for (const f of (await ctx.listFiles(USER_DIR)).filter((f) => f.endsWith('.json'))) {
    try {
      own.push(JSON.parse(await ctx.readFile(`${USER_DIR}/${f}`)));
    } catch {
      // Skip unreadable files rather than breaking the list.
    }
  }
  const names = new Set(own.map((w) => w.name));
  return [...own, ...BUNDLED.filter((w) => !names.has(w.name))];
}

const plugin = definePlugin({
  name: 'workflows',
  version: '0.3.0',
  description: 'Multi-step recipes over the other tools, with approval gates you decide',
  permissions: { read: true, callTools: true },
  tools: [
    {
      name: 'list',
      description: 'Lists the workflows you can start, with their inputs and steps.',
      input: z.object({}),
      readOnly: true,
      async run(_a, ctx) {
        const all = await loadWorkflows(ctx);
        const text = all
          .map(
            (w) =>
              `${w.name}: ${w.description ?? ''}\n  inputs: ${Object.keys(w.inputs ?? {}).join(', ') || 'none'}\n  steps: ${w.steps.map((s) => s.uses ?? `approval(${s.id})`).join(' → ')}`,
          )
          .join('\n');
        return ok(text || 'no workflows', { workflows: all.map((w) => w.name) });
      },
    },
    {
      name: 'start',
      description:
        'Starts a workflow now and runs it until it finishes or reaches an approval gate ' +
        '(which the user decides in the agentbelt CLI). Returns the run with each step result.',
      input: z.object({
        name: z.string().max(64),
        inputs: z
          .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string().max(4000))
          .optional(),
      }),
      async run({ name, inputs }, ctx) {
        const def = (await loadWorkflows(ctx)).find((w) => w.name === name);
        if (!def) return fail(`no workflow named ${name}; see workflows_list`);
        const tools = ctx.listTools();
        const run = await execute(ctx, createRun(def, inputs ?? {}, tools), tools);
        return { text: describe(run), data: { runId: run.id, state: run.state }, isError: false };
      },
    },
    {
      name: 'show',
      description: 'Shows one run: each step, its state and output.',
      input: z.object({ runId: z.string().max(60) }),
      readOnly: true,
      async run({ runId }, ctx) {
        const run = getRun(ctx, runId);
        return run ? ok(describe(run), { state: run.state }) : fail(`no run ${runId}`);
      },
    },
    {
      name: 'runs',
      description: 'Lists recent workflow runs.',
      input: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      readOnly: true,
      async run({ limit }, ctx) {
        const runs = listRuns(ctx).slice(0, limit);
        return ok(
          runs
            .map((r) => `${r.id}  ${r.state.padEnd(16)} ${r.workflow}  ${r.updatedAt}`)
            .join('\n') || 'no runs',
          { runs: runs.map((r) => r.id) },
        );
      },
    },
  ],
});

export default plugin;
