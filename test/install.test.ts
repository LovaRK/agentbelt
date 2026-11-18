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
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepseek } from '../packages/cli/src/adapters.ts';
import { findOnPath } from '@agentbelt/core';
import { npmSync } from './helpers.ts';

const win = process.platform === 'win32';

const root = fileURLToPath(new URL('..', import.meta.url));
const V: string = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
let dir = '';
const pkgs = (v: string) => join(dir, `pkgs-${v}`);

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'packages/cli/dist/cli.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      HOME: join(dir, 'home'),
      // Fake claude/codex first; then only node and git (on Windows also the system folder).
      PATH: [
        join(dir, 'bin'),
        ...(win
          ? [
              dirname(process.execPath),
              dirname(findOnPath('git')!),
              `${process.env.SystemRoot}\\System32`,
            ]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
      AGENTBELT_HOME: join(dir, 'home', '.local', 'share', 'agentbelt'),
      ...(win
        ? {
            // os.homedir() and the app-settings folder come from these on Windows.
            USERPROFILE: join(dir, 'home'),
            APPDATA: join(dir, 'home', 'AppData', 'Roaming'),
            LOCALAPPDATA: join(dir, 'home', 'AppData', 'Local'),
            SystemRoot: process.env.SystemRoot,
            PATHEXT: process.env.PATHEXT,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          }
        : {}),
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const agentbeltHome = () => join(dir, 'home', '.local', 'share', 'agentbelt');
/** The active version: the `current` link on macOS/Linux, state.json on Windows. */
const active = () =>
  win
    ? JSON.parse(readFileSync(join(agentbeltHome(), 'state.json'), 'utf8')).current
    : basename(readlinkSync(join(agentbeltHome(), 'current')));

/** A copy of the packed packages with the CLI package changed to `version` (optionally broken). */
function variant(version: string, broken = false) {
  const out = pkgs(version);
  cpSync(pkgs(V), out, { recursive: true });
  const work = join(dir, `unpack-${version}`);
  mkdirSync(work);
  // Relative paths: some Windows tar builds read `D:\\…` as a remote host.
  execFileSync('tar', ['-xzf', `agentbelt-${V}.tgz`, '-C', relative(out, work)], { cwd: out });
  const pj = join(work, 'package', 'package.json');
  writeFileSync(
    pj,
    readFileSync(pj, 'utf8').replace(`"version": "${V}"`, `"version": "${version}"`),
  );
  if (broken) {
    const entry = join(work, 'package', 'dist', 'cli.js');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8').replace("case 'serve':", "case 'serve': process.exit(3);"),
    );
  }
  rmSync(join(out, `agentbelt-${V}.tgz`));
  execFileSync('tar', ['-czf', `agentbelt-${version}.tgz`, '-C', relative(out, work), 'package'], {
    cwd: out,
  });
}

before(() => {
  npmSync(['run', 'build'], { cwd: root, stdio: 'ignore' });
  dir = mkdtempSync(join(tmpdir(), 'agentbelt-install-'));
  mkdirSync(pkgs(V));
  for (const w of [
    'packages/core',
    'plugins/git',
    'plugins/testing',
    'plugins/workflows',
    'plugins/tokens',
    'plugins/agent',
    'packages/cli',
  ])
    npmSync(['pack', '--pack-destination', pkgs(V)], {
      cwd: join(root, w),
      stdio: 'ignore',
    });
  variant('9.0.1');
  variant('9.0.2', true);
  mkdirSync(join(dir, 'bin'));
  if (!win)
    for (const b of ['node', 'npm', 'git']) symlinkSync(findOnPath(b)!, join(dir, 'bin', b));
  for (const c of ['claude', 'codex']) {
    // Fake client CLI: records calls; `mcp get` succeeds once `mcp add…` was called.
    if (win) {
      const on = join(dir, `${c}.on`);
      writeFileSync(
        join(dir, 'bin', `${c}.cmd`),
        [
          '@echo off',
          `>>"${join(dir, 'calls.log')}" echo ${c} %*`,
          `if "%~1 %~2"=="mcp add" type nul > "${on}"`,
          `if "%~1 %~2"=="mcp remove" if exist "${on}" del "${on}"`,
          `if "%~1 %~2"=="mcp get" if not exist "${on}" exit /b 1`,
          'exit /b 0',
          '',
        ].join('\r\n'),
      );
      continue;
    }
    const f = join(dir, 'bin', c);
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
  const r = cli(['setup', '--from', pkgs(V), '--yes', '--workspace', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`verifying ${V.replaceAll('.', '\\.')} before activating`, 'i'));
  assert.match(r.out, /✓ testing_detect ok/);
  assert.equal(active(), V);
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
  if (win) {
    // Windows apps run node.exe with the JavaScript launcher (no shell, so no .cmd).
    assert.match(
      calls,
      /claude mcp add --scope user agentbelt -- .*node\.exe .*agentbelt\.mjs serve/i,
    );
    assert.match(calls, /codex mcp add agentbelt -- .*node\.exe .*agentbelt\.mjs serve/i);
  } else {
    assert.match(calls, /claude mcp add-json --scope user agentbelt .*"args":\["serve"\]/);
    assert.match(calls, /codex mcp add agentbelt -- .*\/bin\/agentbelt serve/);
  }
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
  const again = cli(['setup', '--from', pkgs(V), '--yes', '--workspace', dir]);
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
  const good = cli(['update', '--from', pkgs('9.0.1'), '--yes']);
  assert.equal(good.code, 0, good.out);
  assert.equal(active(), '9.0.1');
  assert.ok(good.out.includes(`previous: ${V}, kept for rollback`), good.out);

  const bad = cli(['update', '--from', pkgs('9.0.2'), '--yes']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /verification failed, nothing was changed/);
  assert.equal(active(), '9.0.1'); // still the working version
  assert.ok(!existsSync(join(dir, 'home', '.local', 'share', 'agentbelt', 'versions', '9.0.2')));
  assert.equal(cli(['doctor']).code, 0);
});

test('rollback switches back to the previous version; uninstall removes only our entries', () => {
  const r = cli(['rollback']);
  assert.equal(r.code, 0, r.out);
  assert.equal(active(), V);
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
