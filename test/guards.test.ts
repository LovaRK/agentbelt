// Repository guards that CI enforces on every change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.agentbelt'].includes(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

test('first-party plugins act only through the broker (no direct process, file or network access)', () => {
  const forbidden =
    /from ['"](node:)?(child_process|fs|fs\/promises|net|http|https|dgram|worker_threads)['"]/;
  const offenders = files(join(root, 'plugins'))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => forbidden.test(readFileSync(f, 'utf8')))
    .map((f) => relative(root, f));
  assert.deepEqual(offenders, []);
});

test('no personal data, absolute home paths or credentials in tracked files', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.endsWith('package-lock.json') && f !== 'test/guards.test.ts');
  const patterns: [string, RegExp][] = [
    ['absolute home path', /\/Users\/[A-Za-z]|\/home\/[a-z][a-z0-9_-]+\//],
    [
      'email address',
      /\b[A-Za-z0-9._%+-]+@(?!example\.(com|invalid)|agentbelt\.invalid|anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    ],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['token', /\b(ghp_[A-Za-z0-9]{30,}|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/],
  ];
  const problems: string[] = [];
  for (const f of tracked) {
    let text: string;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const [what, re] of patterns) if (re.test(text)) problems.push(`${f}: ${what}`);
  }
  assert.deepEqual(problems, []);
});
