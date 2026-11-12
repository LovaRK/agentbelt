// Versioned installs with verification before activation and atomic switching.
//   install: npm install into a staging folder with lifecycle scripts disabled (--ignore-scripts;
//            npm checks each package's integrity hash), then
//   verify:  start the staged server like a client would and make real tool calls, then
//   activate: move it to versions/<v> and switch `current` with a symlink + rename, which is
//            atomic. A failure at any step leaves the active version untouched. The previous
//            working version is kept for `rollback`.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { StdioClient } from './mcp-client.js';
import { currentLink, home, shimPath, stateFile, versionsDir } from './paths.js';

export interface InstallState {
  current?: string;
  previous?: string;
}

export const readState = (): InstallState => {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
};
const writeState = (s: InstallState) => {
  mkdirSync(home(), { recursive: true });
  writeFileSync(`${stateFile()}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${stateFile()}.tmp`, stateFile());
};

/** The CLI entry point inside an installed version folder. */
export const entryOf = (dir: string) => join(dir, 'node_modules', 'agentbelt', 'dist', 'cli.js');

/** npm-installs `specs` (e.g. "agentbelt@0.1.0" or local .tgz paths) into a new staging folder. */
export function stage(specs: string[], npm = 'npm'): string {
  mkdirSync(versionsDir(), { recursive: true });
  const dir = mkdtempSync(join(versionsDir(), '.staging-'));
  writeFileSync(join(dir, 'package.json'), '{ "private": true }\n');
  try {
    execFileSync(
      npm,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        '--prefix',
        dir,
        ...specs,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const e = error as { stderr?: string; message: string };
    throw new Error(
      `npm install failed: ${(e.stderr ?? e.message).trim().split('\n').slice(-5).join('\n')}`,
    );
  }
  if (!existsSync(entryOf(dir))) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('the installed package has no agentbelt CLI');
  }
  return dir;
}

/** The version string of a staged or installed folder. */
export function versionOf(dir: string): string {
  return JSON.parse(readFileSync(join(dir, 'node_modules', 'agentbelt', 'package.json'), 'utf8'))
    .version;
}

/**
 * Starts the server from `dir` against a throwaway git repo and makes real tool calls.
 * Throws with the reason if anything fails.
 */
export async function verify(dir: string, node = process.execPath): Promise<string[]> {
  const repo = mkdtempSync(join(tmpdir(), 'agentbelt-verify-'));
  const done: string[] = [];
  let client: StdioClient | null = null;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(
      join(repo, 'package.json'),
      '{ "name": "verify", "scripts": { "test": "node -e 0" } }\n',
    );
    client = new StdioClient(node, [entryOf(dir), 'serve', '--workspace', repo]);
    const init = await client.initialize('agentbelt-verify');
    done.push(`handshake ok (${init.serverInfo?.name} ${init.serverInfo?.version})`);
    const tools = (await client.request('tools/list')).tools.map((t: any) => t.name);
    for (const required of ['agentbelt_status', 'git_status', 'testing_detect', 'workflows_list'])
      if (!tools.includes(required)) throw new Error(`tool ${required} is missing`);
    done.push(`${tools.length} tools listed`);
    for (const [tool, expect] of [
      ['git_status', /## (No commits yet on )?main/],
      ['testing_detect', /test: npm test/],
      ['workflows_list', /safe-commit/],
    ] as const) {
      const r = await client.callTool(tool);
      if (r.isError || !expect.test(r.text))
        throw new Error(`${tool} returned: ${r.text.slice(0, 300)}`);
      done.push(`${tool} ok`);
    }
    return done;
  } finally {
    client?.close();
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Points `current` at `target` atomically (a new symlink renamed over the old one). */
function switchTo(target: string) {
  const tmp = `${currentLink()}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, currentLink());
}

/** Moves a verified staging folder into place and makes it current. */
export function activate(stagingDir: string): InstallState {
  const version = versionOf(stagingDir);
  const target = join(versionsDir(), version);
  const state = readState();
  if (state.current === version) {
    // Reinstalling the active version: keep the active folder until the new one is in place.
    const old = `${target}.old-${process.pid}`;
    renameSync(target, old);
    renameSync(stagingDir, target);
    switchTo(target);
    rmSync(old, { recursive: true, force: true });
    return state;
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(stagingDir, target);
  switchTo(target);
  const next = { current: version, previous: state.current ?? state.previous };
  writeState(next);
  pruneVersions(next);
  return next;
}

/** Switches back to the previous version (kept on disk). */
export function rollback(): InstallState {
  const state = readState();
  if (!state.previous || !existsSync(join(versionsDir(), state.previous)))
    throw new Error('there is no previous version to roll back to');
  switchTo(join(versionsDir(), state.previous));
  const next = { current: state.previous, previous: state.current };
  writeState(next);
  return next;
}

/** Keeps only the current and previous versions. */
function pruneVersions(state: InstallState) {
  const keep = new Set([state.current, state.previous]);
  for (const v of existsSync(versionsDir()) ? readdirSync(versionsDir()) : [])
    if (!v.startsWith('.') && !keep.has(v))
      rmSync(join(versionsDir(), v), { recursive: true, force: true });
}

export function activeVersion(): string | null {
  try {
    return basename(readlinkSync(currentLink()));
  } catch {
    return null;
  }
}

/**
 * A stable path to this Node binary: a `node` on PATH that resolves to the same file (e.g.
 * /opt/homebrew/bin/node rather than a versioned Cellar path that disappears on upgrade).
 */
export function stableNode(execPath = process.execPath): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'node');
    try {
      if (dir && realpathSync(candidate) === real) return candidate;
    } catch {
      // not here
    }
  }
  return execPath;
}

/** The command every client config runs: a shim pointing at the current version. */
export function writeShim(node = stableNode()): string {
  const file = shimPath();
  mkdirSync(join(file, '..'), { recursive: true });
  const script = `#!/bin/sh\n# agentbelt shim: runs the active version (see \`agentbelt doctor\`).\nexec ${JSON.stringify(node)} ${JSON.stringify(entryOf(currentLink()))} "$@"\n`;
  writeFileSync(`${file}.tmp`, script);
  chmodSync(`${file}.tmp`, 0o755);
  renameSync(`${file}.tmp`, file);
  return file;
}
