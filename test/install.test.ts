// End-to-end install lifecycle in a fake HOME with fake `claude` and `codex` commands, so no real
// client configuration is ever touched. Builds and packs the workspace packages first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepseek } from '../packages/cli/src/adapters.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
let dir = '';
const which = (b: string) => execFileSync('which', [b], { encoding: 'utf8' }).trim();
const pkgs = (v: string) => join(dir, `pkgs-${v}`);

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'packages/cli/dist/cli.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      HOME: join(dir, 'home'),
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      AGENTBELT_HOME: join(dir, 'home', '.local', 'share', 'agentbelt'),
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const active = () =>
  basename(readlinkSync(join(dir, 'home', '.local', 'share', 'agentbelt', 'current')));

/** A copy of the packed packages with the CLI package changed to `version` (optionally broken). */
function variant(version: string, broken = false) {
  const out = pkgs(version);
  cpSync(pkgs('0.1.0'), out, { recursive: true });
  const work = join(dir, `unpack-${version}`);
  mkdirSync(work);
  execFileSync('tar', ['-xzf', join(out, 'agentbelt-0.1.0.tgz'), '-C', work]);
  const pj = join(work, 'package', 'package.json');
  writeFileSync(
    pj,
    readFileSync(pj, 'utf8').replace('"version": "0.1.0"', `"version": "${version}"`),
  );
  if (broken) {
    const entry = join(work, 'package', 'dist', 'cli.js');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8').replace("case 'serve':", "case 'serve': process.exit(3);"),
    );
  }
  rmSync(join(out, 'agentbelt-0.1.0.tgz'));
  execFileSync('tar', ['-czf', join(out, `agentbelt-${version}.tgz`), '-C', work, 'package']);
}

before(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  dir = mkdtempSync(join(tmpdir(), 'agentbelt-install-'));
  mkdirSync(pkgs('0.1.0'));
  for (const w of [
    'packages/core',
    'plugins/git',
    'plugins/testing',
    'plugins/workflows',
    'plugins/agent',
    'packages/cli',
  ])
    execFileSync('npm', ['pack', '--pack-destination', pkgs('0.1.0')], {
      cwd: join(root, w),
      stdio: 'ignore',
    });
  variant('0.1.1');
  variant('0.1.2', true);
  mkdirSync(join(dir, 'bin'));
  for (const b of ['node', 'npm', 'git']) symlinkSync(which(b), join(dir, 'bin', b));
  for (const c of ['claude', 'codex']) {
    const f = join(dir, 'bin', c);
    // Fake client CLI: records calls; `mcp get` succeeds once `mcp add…` was called.
    writeFileSync(
      f,
      `#!/bin/sh\necho "${c} $*" >> "${dir}/calls.log"\ncase "$*" in\n  "mcp add"*) touch "${dir}/${c}.on";;\n  "mcp remove"*) rm -f "${dir}/${c}.on";;\n  "mcp get"*) [ -f "${dir}/${c}.on" ] || exit 1;;\nesac\nexit 0\n`,
    );
    chmodSync(f, 0o755);
  }
  mkdirSync(join(dir, 'home', '.dsh', 'profiles', 'desktop'), { recursive: true });
  writeFileSync(
    join(dir, 'home', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    '# mine\n- id: x\n  name: y\n',
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('setup installs a verified copy, connects all three clients, and doctor passes', () => {
  const r = cli(['setup', '--from', pkgs('0.1.0'), '--yes', '--workspace', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verifying 0\.1\.0 before activating/i);
  assert.match(r.out, /✓ testing_detect ok/);
  assert.equal(active(), '0.1.0');
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /claude mcp add-json --scope user agentbelt .*"args":\["serve"\]/);
  assert.match(calls, /codex mcp add agentbelt -- .*\/bin\/agentbelt serve/);
  const patch = readFileSync(
    join(dir, 'home', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    'utf8',
  );
  assert.match(patch, /^# mine\n- id: x\n {2}name: y\n/); // the user's content is kept
  assert.match(patch, /serverName: agentbelt/);
  assert.match(patch, /"serve", "--workspace", "/); // DeepSeek gives no roots, so it is pinned
  assert.match(r.out, /Claude Code: connected/);
  assert.match(r.out, /Codex: connected/);
  // Running setup again changes nothing.
  const again = cli(['setup', '--from', pkgs('0.1.0'), '--yes', '--workspace', dir]);
  assert.equal(again.code, 0, again.out);
  assert.equal(
    readFileSync(
      join(dir, 'home', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
      'utf8',
    ).match(/>>> agentbelt/g)!.length,
    1,
  );
});

test('update verifies before switching; a broken release never becomes active', () => {
  const good = cli(['update', '--from', pkgs('0.1.1'), '--yes']);
  assert.equal(good.code, 0, good.out);
  assert.equal(active(), '0.1.1');
  assert.match(good.out, /previous: 0\.1\.0, kept for rollback/);

  const bad = cli(['update', '--from', pkgs('0.1.2'), '--yes']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /verification failed, nothing was changed/);
  assert.equal(active(), '0.1.1'); // still the working version
  assert.ok(!existsSync(join(dir, 'home', '.local', 'share', 'agentbelt', 'versions', '0.1.2')));
  assert.equal(cli(['doctor']).code, 0);
});

test('rollback switches back to the previous version; uninstall removes only our entries', () => {
  const r = cli(['rollback']);
  assert.equal(r.code, 0, r.out);
  assert.equal(active(), '0.1.0');
  assert.equal(cli(['doctor']).code, 0);

  const u = cli(['uninstall', '--yes']);
  assert.equal(u.code, 0, u.out);
  assert.equal(
    readFileSync(join(dir, 'home', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    '# mine\n- id: x\n  name: y\n',
  );
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
  assert.match(
    calls.trim().split('\n').slice(-4).join('\n'),
    /claude mcp remove --scope user agentbelt[\s\S]*codex mcp remove agentbelt/,
  );
});

test('the DeepSeek block is replaced, not duplicated, and removal is exact', () => {
  const home = join(dir, 'ds');
  mkdirSync(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true });
  const file = join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  writeFileSync(file, 'a: 1\n');
  const a = deepseek(home);
  assert.equal(a.needsWorkspace, true); // no roots, cwd is the profile folder
  a.add({ command: '/x y/agentbelt', args: ['serve'] });
  a.add({ command: '/z/agentbelt', args: ['serve'] });
  const text = readFileSync(file, 'utf8');
  assert.equal(text.match(/>>> agentbelt/g)!.length, 1);
  assert.match(text, /command: "\/z\/agentbelt"/);
  a.remove();
  assert.equal(readFileSync(file, 'utf8'), 'a: 1\n');
});

test('--help prints help and never runs the command', () => {
  for (const command of ['setup', 'update', 'uninstall', 'rollback']) {
    const r = cli([command, '--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /safe git, testing and workflow tools/);
    assert.doesNotMatch(r.out, /Installing|Verifying|removed|rolled back/i);
  }
});
