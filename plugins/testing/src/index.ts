// Testing plugin: finds the project's own checks (typecheck, lint, build, tests) and runs them.
// Supports npm/pnpm/yarn scripts, Swift packages, Cargo, Go and pytest. Commands run through the
// broker: argv only, a minimal environment, a timeout, and only these programs.
import { definePlugin, fail, ok, type PluginContext } from '@agentbelt/core';
import * as z from 'zod';

export interface Check {
  name: string;
  program: string;
  args: string[];
}

const ORDER = ['typecheck', 'lint', 'build', 'test'];
const taskDir = (id?: string) => (id ? `.agentbelt/worktrees/${id}` : '.');

async function read(ctx: PluginContext, path: string): Promise<string | null> {
  try {
    return await ctx.readFile(path);
  } catch {
    return null;
  }
}

/** The checks a project defines, in the order typecheck → lint → build → test. */
export async function detectChecks(ctx: PluginContext, dir = '.'): Promise<Check[]> {
  const at = (f: string) => (dir === '.' ? f : `${dir}/${f}`);
  const files = new Set(await ctx.listFiles(dir));
  const checks: Check[] = [];
  const pkgText = files.has('package.json') ? await read(ctx, at('package.json')) : null;
  if (pkgText) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(pkgText).scripts ?? {};
    } catch {
      // An unreadable package.json simply has no scripts.
    }
    const pm = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : 'npm';
    for (const name of ORDER)
      if (scripts[name] && !/no test specified/.test(scripts[name]))
        checks.push({
          name,
          program: pm,
          args: name === 'test' ? ['test'] : ['run', name],
        });
  }
  if (files.has('Package.swift')) {
    checks.push({ name: 'build', program: 'swift', args: ['build'] });
    checks.push({ name: 'test', program: 'swift', args: ['test'] });
  }
  if (files.has('Cargo.toml')) checks.push({ name: 'test', program: 'cargo', args: ['test'] });
  if (files.has('go.mod')) {
    checks.push({ name: 'vet', program: 'go', args: ['vet', './...'] });
    checks.push({ name: 'test', program: 'go', args: ['test', './...'] });
  }
  if (!pkgText && (files.has('pytest.ini') || files.has('pyproject.toml') || files.has('tests')))
    checks.push({ name: 'test', program: 'pytest', args: ['-q'] });
  return checks;
}

/** Lines that usually mark a failure or error in test, build and lint output. */
const FAILURE =
  /\bnot ok\b|\bFAIL(?:ED|URE|S)?\b|\b\w*Error\b|\bpanicked\b|Traceback|✗|✖|×|^\s*E\s{2,}|^\s*●\s/;

export interface ExcerptLimits {
  /** Logs at most this many lines long are returned whole. */
  maxLines: number;
  /** Lines kept from the end of the log. */
  tailLines: number;
  /** Lines (matches plus context) kept from failures before the tail. */
  failureLines: number;
  /** Context kept around each failure line. */
  before: number;
  after: number;
  /** Longer lines are cut to this many characters. */
  lineChars: number;
}

const LIMITS: ExcerptLimits = {
  maxLines: 80,
  tailLines: 40,
  failureLines: 60,
  before: 2,
  after: 4,
  lineChars: 300,
};

/**
 * A bounded excerpt of a failing check's output: the lines that look like failures (with a little
 * context) plus the tail, each with its line number, and a note of what was left out. A failure in
 * the middle of a long log stays visible, which a plain tail would hide.
 */
export function excerpt(text: string, limits: Partial<ExcerptLimits> = {}): string {
  const l = { ...LIMITS, ...limits };
  const all = text.trimEnd().split('\n');
  const cut = (s: string) => (s.length > l.lineChars ? `${s.slice(0, l.lineChars)} …` : s);
  if (all.length <= l.maxLines) return all.map(cut).join('\n');

  const tailStart = all.length - l.tailLines;
  const keep = new Set<number>();
  let matches = 0;
  let shown = 0;
  for (let i = 0; i < tailStart; i++) {
    if (!FAILURE.test(all[i]!)) continue;
    matches++;
    const range: number[] = [];
    for (let j = Math.max(0, i - l.before); j <= Math.min(tailStart - 1, i + l.after); j++)
      if (!keep.has(j)) range.push(j);
    if (keep.size + range.length > l.failureLines) continue;
    range.forEach((j) => keep.add(j));
    shown++;
  }
  for (let i = tailStart; i < all.length; i++) keep.add(i);

  const width = String(all.length).length;
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push(`… ${i - prev - 1} lines omitted (${prev + 2}–${i}) …`);
    out.push(`${String(i + 1).padStart(width)}| ${cut(all[i]!)}`);
    prev = i;
  }
  const header =
    `[${all.length} lines; showing ${keep.size}: ` +
    (matches
      ? `${shown} of ${matches} failure-like lines above the tail with context, `
      : 'no failure-like lines above the tail, ') +
    `and the last ${l.tailLines}]`;
  return `${header}\n${out.join('\n')}`;
}
const taskArg = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
  .optional()
  .describe('Run in this git task worktree instead of the main checkout');

export default definePlugin({
  name: 'testing',
  version: '0.3.0',
  description: "Detects and runs the project's own typecheck, lint, build and test commands",
  permissions: { exec: ['npm', 'pnpm', 'yarn', 'swift', 'cargo', 'go', 'pytest'], read: true },
  tools: [
    {
      name: 'detect',
      description: 'Lists the checks this project defines and the exact commands they run.',
      input: z.object({ task: taskArg }),
      readOnly: true,
      async run({ task }, ctx) {
        const checks = await detectChecks(ctx, taskDir(task));
        if (!checks.length)
          return ok(
            'No checks found (package.json scripts, Package.swift, Cargo.toml, go.mod, pytest).',
            { checks },
          );
        return ok(checks.map((c) => `${c.name}: ${c.program} ${c.args.join(' ')}`).join('\n'), {
          checks,
        });
      },
    },
    {
      name: 'run_checks',
      description:
        "Runs the project's checks (all, or the named ones) and reports pass/fail. For each " +
        'failure it shows the lines that look like errors (with line numbers and context) plus the ' +
        'end of the output. Note: this runs the project’s own scripts.',
      input: z.object({
        task: taskArg,
        only: z.array(z.string().max(40)).max(10).optional().describe('e.g. ["test"]'),
        timeoutMinutes: z.number().int().min(1).max(60).default(15),
      }),
      async run({ task, only, timeoutMinutes }, ctx) {
        const dir = taskDir(task);
        const checks = (await detectChecks(ctx, dir)).filter(
          (c) => !only?.length || only.includes(c.name),
        );
        if (!checks.length) return fail('No matching checks found in this project.');
        const results = [];
        for (const c of checks) {
          const r = await ctx.exec(c.program, c.args, {
            cwd: dir,
            timeoutMs: timeoutMinutes * 60_000,
          });
          results.push({
            name: c.name,
            command: `${c.program} ${c.args.join(' ')}`,
            passed: r.exitCode === 0,
            exitCode: r.exitCode,
            seconds: Math.round(r.durationMs / 100) / 10,
            output: r.exitCode === 0 ? '' : excerpt(`${r.stdout}\n${r.stderr}`),
          });
        }
        const passed = results.every((r) => r.passed);
        const lines = results.map(
          (r) => `${r.passed ? 'PASS' : 'FAIL'}  ${r.name}  (${r.command}, ${r.seconds}s)`,
        );
        for (const r of results.filter((x) => !x.passed))
          lines.push(`\n--- ${r.name} output ---\n${r.output}`);
        return {
          text: `${passed ? 'All checks passed' : 'Some checks failed'}\n${lines.join('\n')}`,
          data: { passed, results },
          isError: false,
        };
      },
    },
  ],
});
