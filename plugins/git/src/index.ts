// Git plugin: read the repository, and make changes in isolated task worktrees.
// Task work happens in .agentbelt/worktrees/<id> on branch agentbelt/<id>, so the user's
// checkout and main branch are never touched. There is no push, fetch, reset or checkout.
import { randomBytes } from 'node:crypto';
import { definePlugin, fail, ok, type PluginContext } from '@agentbelt/core';
import * as z from 'zod';

const TASK = /^[a-z0-9][a-z0-9-]{0,40}$/;
const taskDir = (id: string) => `.agentbelt/worktrees/${id}`;
const MAX_DIFF = 60_000;

async function git(ctx: PluginContext, args: string[], cwd?: string) {
  const r = await ctx.exec('git', args, { cwd, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function taskExists(ctx: PluginContext, id: string): Promise<boolean> {
  const list = await git(ctx, ['worktree', 'list', '--porcelain']);
  return list.includes(`branch refs/heads/agentbelt/${id}\n`) || list.endsWith(`agentbelt/${id}`);
}

const taskArg = z
  .string()
  .regex(TASK)
  .optional()
  .describe('Task id from git_task_start; omit for the main checkout');

export default definePlugin({
  name: 'git',
  version: '0.3.0',
  description: 'Repository status, diffs and history; changes in isolated task branches',
  permissions: { exec: ['git'], read: true },
  tools: [
    {
      name: 'status',
      description: 'Current branch, and the files that are changed, staged or untracked.',
      input: z.object({ task: taskArg }),
      readOnly: true,
      async run({ task }, ctx) {
        const out = await git(ctx, ['status', '--short', '--branch'], task && taskDir(task));
        const [branch, ...files] = out.trimEnd().split('\n');
        return ok(out.trim() || 'clean', {
          branch: branch?.replace(/^## /, ''),
          files: files.filter(Boolean),
        });
      },
    },
    {
      name: 'diff',
      description: 'The diff of uncommitted changes (or staged ones), optionally for one path.',
      input: z.object({
        task: taskArg,
        staged: z.boolean().optional(),
        path: z.string().max(500).optional().describe('Limit to this file or folder'),
      }),
      readOnly: true,
      async run({ task, staged, path }, ctx) {
        const args = ['diff', ...(staged ? ['--cached'] : []), ...(path ? ['--', path] : [])];
        const out = await git(ctx, args, task && taskDir(task));
        const text = out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n[diff truncated]` : out;
        return ok(text || 'no changes', { bytes: out.length });
      },
    },
    {
      name: 'log',
      description: 'Recent commits (one line each).',
      input: z.object({ task: taskArg, limit: z.number().int().min(1).max(100).default(10) }),
      readOnly: true,
      async run({ task, limit }, ctx) {
        const out = await git(ctx, ['log', '--oneline', `-${limit}`], task && taskDir(task));
        return ok(out.trim() || 'no commits', { commits: out.trim().split('\n').filter(Boolean) });
      },
    },
    {
      name: 'task_start',
      description:
        'Creates an isolated task: a new worktree in .agentbelt/worktrees/<id> on branch ' +
        'agentbelt/<id>, from the current commit. Make changes there, then use git_commit.',
      input: z.object({
        name: z
          .string()
          .regex(/^[a-z0-9-]{1,30}$/)
          .describe('Short slug, e.g. fix-login'),
      }),
      async run({ name }, ctx) {
        const id = `${name}-${randomBytes(3).toString('hex')}`;
        await git(ctx, ['worktree', 'add', '-b', `agentbelt/${id}`, taskDir(id)]);
        return ok(
          `Created task ${id}\n  folder: ${ctx.workspace}/${taskDir(id)}\n  branch: agentbelt/${id}`,
          { task: id, path: `${ctx.workspace}/${taskDir(id)}`, branch: `agentbelt/${id}` },
        );
      },
    },
    {
      name: 'tasks',
      description: 'Lists agentbelt task worktrees and their branches.',
      input: z.object({}),
      readOnly: true,
      async run(_args, ctx) {
        const out = await git(ctx, ['worktree', 'list', '--porcelain']);
        const tasks = out
          .split('\n\n')
          .map((block) => /branch refs\/heads\/agentbelt\/(\S+)/.exec(block)?.[1])
          .filter((t): t is string => !!t);
        return ok(tasks.length ? tasks.join('\n') : 'no tasks', { tasks });
      },
    },
    {
      name: 'commit',
      description:
        'Commits all changes in a task worktree to its agentbelt/<id> branch. Never commits to ' +
        'your current branch and never pushes.',
      input: z.object({
        task: z.string().regex(TASK).describe('Task id from git_task_start'),
        message: z.string().min(1).max(2000),
      }),
      async run({ task, message }, ctx) {
        if (!(await taskExists(ctx, task))) return fail(`no task ${task}`);
        const dir = taskDir(task);
        await git(ctx, ['add', '-A'], dir);
        const staged = await git(ctx, ['diff', '--cached', '--name-only'], dir);
        if (!staged.trim()) return fail('nothing to commit');
        await git(ctx, ['commit', '-q', '-m', message], dir);
        const sha = (await git(ctx, ['rev-parse', '--short', 'HEAD'], dir)).trim();
        const files = staged.trim().split('\n');
        return ok(`Committed ${sha} on agentbelt/${task} (${files.length} file(s))`, {
          commit: sha,
          branch: `agentbelt/${task}`,
          files,
        });
      },
    },
  ],
});
