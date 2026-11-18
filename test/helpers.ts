import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { launchFor } from '@agentbelt/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway git repo with one commit and an npm test script. */
export function tempRepo(scripts: Record<string, string> = { test: 'node check.js' }): {
  dir: string;
  git: (...args: string[]) => string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'agentbelt-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), '.agentbelt/\nnode_modules/\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts }, null, 2));
  writeFileSync(join(dir, 'check.js'), "console.log('ok');\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs npm without a shell (on Windows npm is a .cmd file, so this runs node npm-cli.js). */
export function npmSync(args: string[], options: ExecFileSyncOptions = {}) {
  const npm = launchFor('npm', args);
  return execFileSync(npm.file, npm.args, options);
}
