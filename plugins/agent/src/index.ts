// Optional coding agent. It runs a bounded tool loop with the model the user chose at
// `agentbelt agent setup` (a local OpenAI-compatible server, the DeepSeek API, or any endpoint).
// The MCP client's own model calls `agent_run` to hand a task to that model.
//
// The agent has no powers of its own: every file read or write goes through the broker (workspace
// only, never .git or .agentbelt), checks run through the testing plugin, and the diff through the
// git plugin. Writing is off unless the caller passes write: true. All of it is audited.
// The loop is ported from local-ai-harness src/agent.ts.
import * as z from 'zod';
import { definePlugin, fail, ok, type PluginContext } from '@agentbelt/core';
import type { ChatMessage, ToolSpec } from '@agentbelt/core';
import {
  compactMessages,
  tokensReport,
  type CompactionOptions,
  type RunTokens,
} from '@agentbelt/plugin-tokens';

const SYSTEM =
  'You are a careful coding agent working in one project. Act only by calling the provided tools; ' +
  'never claim to have done something you did not do with a tool. Paths are relative to the ' +
  'project root. If a tool returns an error, read it and try a corrected approach. When the task ' +
  'is complete, reply with a short final answer (what you found or changed) and no tool call.';

const clip = (s: string, n = 12_000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

interface AgentTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<string>;
}

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string`);
  return v;
};

/** The tools the agent's model may call, all backed by the broker. */
export function agentTools(ctx: PluginContext, write: boolean): AgentTool[] {
  const installed = new Set(ctx.listTools());
  const tools: AgentTool[] = [
    {
      spec: fn('list_files', 'List the names in a project directory.', {
        dir: { type: 'string', description: 'Directory, e.g. "." or "src"' },
      }),
      run: async (a) => (await ctx.listFiles(typeof a.dir === 'string' ? a.dir : '.')).join('\n'),
    },
    {
      spec: fn('read_file', 'Read a text file in the project.', { path: { type: 'string' } }, [
        'path',
      ]),
      run: async (a) => clip(await ctx.readFile(str(a.path, 'path'))),
    },
  ];
  if (write)
    tools.push({
      spec: fn(
        'write_file',
        'Create or replace a text file in the project with the full new content.',
        { path: { type: 'string' }, content: { type: 'string' } },
        ['path', 'content'],
      ),
      run: async (a) => {
        if (typeof a.content !== 'string') throw new Error('content must be a string');
        await ctx.writeFile(str(a.path, 'path'), a.content);
        return `wrote ${a.path}`;
      },
    });
  if (installed.has('testing_run_checks'))
    tools.push({
      spec: fn(
        'run_checks',
        "Run the project's build, lint and tests; returns PASS/FAIL lines.",
        {},
      ),
      run: async () => clip((await ctx.callTool('testing_run_checks', {})).text),
    });
  if (installed.has('git_diff'))
    tools.push({
      spec: fn('git_diff', 'Show the uncommitted changes in the project.', {}),
      run: async () => clip((await ctx.callTool('git_diff', {})).text),
    });
  return tools;
}

export type AgentStatus = 'completed' | 'max_steps' | 'too_many_errors' | 'model_error';

export interface AgentRun {
  status: AgentStatus;
  answer: string | null;
  steps: number;
  toolCalls: { name: string; ok: boolean }[];
  error?: string;
  /** Token counts the model server reported, and what compaction did (if it was on). */
  tokens: Omit<RunTokens, 'id' | 'at' | 'model' | 'task' | 'status' | 'steps'>;
}

/** The bounded loop: ask the model, run its tool calls, feed results back, until it answers. */
export async function runAgent(
  ctx: PluginContext,
  task: string,
  opts: {
    write: boolean;
    maxSteps: number;
    maxConsecutiveErrors?: number;
    /** Off by default. When set, older tool results are compacted to stay under the budget. */
    compaction?: CompactionOptions;
  },
): Promise<AgentRun> {
  const model = ctx.model!;
  const tools = agentTools(ctx, opts.write);
  const byName = new Map(tools.map((t) => [t.spec.function.name, t]));
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${task}\n\n${opts.write ? 'You may change files.' : 'Do not change files: you can only read and report.'}`,
    },
  ];
  const run: AgentRun = {
    status: 'max_steps',
    answer: null,
    steps: 0,
    toolCalls: [],
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      maxInputTokens: 0,
      unreportedCalls: 0,
      compaction: {
        enabled: Boolean(opts.compaction),
        ...(opts.compaction ? { budgetTokens: opts.compaction.budgetTokens } : {}),
        compactedCalls: 0,
        duplicates: 0,
        summarized: 0,
        estimatedTokensRemoved: 0,
      },
    },
  };
  const t = run.tokens;
  const maxErrors = opts.maxConsecutiveErrors ?? 3;
  let errors = 0;
  while (run.steps < opts.maxSteps) {
    run.steps += 1;
    // The full history stays in `messages`; compaction only changes what is sent this call.
    let sent = messages;
    if (opts.compaction) {
      const c = compactMessages(messages, opts.compaction);
      if (c.stats.duplicates || c.stats.summarized) {
        sent = c.messages;
        t.compaction.compactedCalls += 1;
        t.compaction.duplicates = Math.max(t.compaction.duplicates, c.stats.duplicates);
        t.compaction.summarized = Math.max(t.compaction.summarized, c.stats.summarized);
        t.compaction.estimatedTokensRemoved += c.stats.estimatedBefore - c.stats.estimatedAfter;
      }
    }
    let reply;
    try {
      reply = await model.chat({ messages: sent, tools: tools.map((x) => x.spec) });
    } catch (error) {
      run.status = 'model_error';
      run.error = (error as Error).message;
      return run;
    }
    if (reply.usage.inputTokens === null && reply.usage.outputTokens === null)
      t.unreportedCalls += 1;
    t.inputTokens += reply.usage.inputTokens ?? 0;
    t.outputTokens += reply.usage.outputTokens ?? 0;
    t.maxInputTokens = Math.max(t.maxInputTokens, reply.usage.inputTokens ?? 0);
    if (!reply.toolCalls.length) {
      const text = (reply.content ?? '').trim();
      if (text && reply.finishReason !== 'length') {
        run.status = 'completed';
        run.answer = text;
        return run;
      }
      // Empty or cut-off reply: say why and let the model try again.
      errors += 1;
      if (text) messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content:
          reply.finishReason === 'length'
            ? 'Your reply was cut off. Either call one tool or give a short final answer.'
            : 'Your reply was empty. Call a tool, or give a short final answer.',
      });
      if (errors >= maxErrors) return { ...run, status: 'too_many_errors' };
      continue;
    }
    messages.push(reply.assistantMessage);
    for (const call of reply.toolCalls) {
      const tool = byName.get(call.name);
      let output: string;
      let okay = false;
      if (call.error) output = `ERROR: ${call.error}. Send a JSON object.`;
      else if (!tool)
        output = `ERROR: unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}`;
      else {
        try {
          output = await tool.run(call.arguments ?? {});
          okay = true;
        } catch (error) {
          output = `ERROR: ${(error as Error).message}`;
        }
      }
      run.toolCalls.push({ name: call.name, ok: okay });
      errors = okay ? 0 : errors + 1;
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
    if (errors >= maxErrors) return { ...run, status: 'too_many_errors' };
  }
  return run;
}

const RUNS_KEY = 'runs';
const KEEP_RUNS = 200;

export default definePlugin({
  name: 'agent',
  version: '0.3.1',
  description:
    'Optional coding agent: hands a task to the model chosen at `agentbelt agent setup`, which works through the broker.',
  permissions: { read: true, write: true, callTools: true, model: true },
  tools: [
    {
      name: 'run',
      description:
        'Hand a coding task to the separately configured agent model (local or remote, chosen by the user). ' +
        'It can list and read project files, run the checks and see the diff; it changes files only with write: true. ' +
        'compact: true keeps long runs inside a small context window by summarizing older tool results. ' +
        'Returns its answer, the tools it used and the tokens the model server reported.',
      input: z.object({
        task: z.string().min(1).max(8000),
        write: z.boolean().default(false),
        maxSteps: z.number().int().min(1).max(40).default(15),
        compact: z.boolean().default(false),
        contextBudget: z.number().int().min(1000).max(1_000_000).default(10_000),
      }),
      destructive: true,
      async run({ task, write, maxSteps, compact, contextBudget }, ctx) {
        if (!ctx.model)
          return fail(
            'No agent model is configured. The user can set one up with: agentbelt agent setup',
          );
        const r = await runAgent(ctx, task, {
          write,
          maxSteps,
          ...(compact ? { compaction: { budgetTokens: contextBudget } } : {}),
        });
        const record: RunTokens = {
          id: `run-${Date.now().toString(36)}`,
          at: new Date().toISOString(),
          model: ctx.model.name,
          task: task.slice(0, 200),
          status: r.status,
          steps: r.steps,
          ...r.tokens,
        };
        try {
          const runs = ctx.state.get<RunTokens[]>(RUNS_KEY) ?? [];
          ctx.state.set(RUNS_KEY, [...runs, record].slice(-KEEP_RUNS));
        } catch {
          // A read-only workspace must not lose the agent's answer.
        }
        const tk = r.tokens;
        const used = r.toolCalls.map((t) => `${t.name}${t.ok ? '' : ' (error)'}`).join(', ');
        const text = [
          `agent model: ${ctx.model.name} @ ${ctx.model.endpoint}`,
          `status: ${r.status} after ${r.steps} step(s)`,
          `tools used: ${used || 'none'}`,
          `tokens (reported by the model server): input ${tk.inputTokens}, output ${tk.outputTokens}, largest prompt ${tk.maxInputTokens}; compaction ${tk.compaction.enabled ? `on (budget ${contextBudget}, used in ${tk.compaction.compactedCalls} call(s))` : 'off'}`,
          r.error ? `error: ${r.error}` : '',
          '',
          r.answer ?? '(no final answer)',
        ]
          .filter((l, i) => l || i === 5)
          .join('\n');
        const data = {
          status: r.status,
          steps: r.steps,
          toolCalls: r.toolCalls,
          answer: r.answer,
          tokens: record,
        };
        return r.status === 'completed' ? ok(text, data) : fail(text, data);
      },
    },
    {
      name: 'runs',
      description:
        'Recent agent_run calls in this project with the input and output tokens the model server reported and whether compaction was on.',
      input: z.object({ limit: z.number().int().min(1).max(KEEP_RUNS).default(20) }),
      readOnly: true,
      async run({ limit }, ctx) {
        const runs = (ctx.state.get<RunTokens[]>(RUNS_KEY) ?? []).slice(-limit);
        return ok(tokensReport(runs), { runs });
      },
    },
  ],
});
