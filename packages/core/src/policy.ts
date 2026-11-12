// Command policy for every program agentbelt runs on the host. Commands are parsed as argv
// (never a shell string): an allowlisted program, a per-program rule over its arguments, and a
// path check on every argument (lexical, symlink-resolved, and protected directories).
// Denials are returned to the caller, which records them in the audit log.
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv } from './env.js';

interface Context {
  cwd: string;
}
/** Returns a denial reason, or null when the arguments are acceptable. */
type Rule = (args: string[], ctx: Context) => string | null;

const flagName = (arg: string) => arg.split('=')[0];
const hasFlag = (args: string[], flags: string[]) => args.find((a) => flags.includes(flagName(a)));
/** True for a short-option cluster such as `-iO` that contains any of `letters`. */
const shortCluster = (arg: string, letters: string) =>
  /^-[^-]/.test(arg) && [...arg.slice(1)].some((c) => letters.includes(c));

// find actions that delete files, run programs or write files.
const FIND_ACTIONS = ['-delete', '-exec', '-execdir', '-ok', '-okdir'];
const FIND_WRITERS = ['-fprint', '-fprint0', '-fprintf', '-fls'];

// git: read-only subcommands plus the additive ones agentbelt needs. Everything that talks to
// the network, rewrites config, or discards work (push, fetch, clone, config, reset, clean,
// checkout, restore, rm, stash, rebase, …) is not on the list.
const GIT_SUBCOMMANDS = [
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'grep',
  'blame',
  'describe',
  'shortlog',
  'branch',
  'add',
  'commit',
  'init',
  'worktree',
  'merge-base',
];

const NPM_SUBCOMMANDS = ['test', 't', 'run', 'run-script', 'ls', 'list'];

const SWIFT_SUBCOMMANDS = ['build', 'test', 'run', 'package'];
const SWIFT_PACKAGE_SUBCOMMANDS = [
  'describe',
  'dump-package',
  'show-dependencies',
  'clean',
  'init',
];
const SWIFT_DENIED_FLAGS = [
  '--disable-sandbox',
  '--allow-network-connections',
  '--allow-writing-to-package-directory',
  '--allow-writing-to-directory',
];

// xcodebuild has too many actions for an allowlist; block the ones that install, download,
// change signing state, or export.
const XCODEBUILD_DENIED_FLAGS = [
  '-allowProvisioningUpdates',
  '-allowProvisioningDeviceRegistration',
  '-exportArchive',
  '-exportNotarizedApp',
  '-runFirstLaunch',
  '-downloadPlatform',
  '-downloadAllPlatforms',
  '-downloadComponent',
  '-importPlatform',
  '-installComponent',
  '-license',
];

const SIMCTL_SUBCOMMANDS = [
  'list',
  'boot',
  'shutdown',
  'bootstatus',
  'install',
  'uninstall',
  'launch',
  'terminate',
  'io',
  'openurl',
  'get_app_container',
  'help',
];
const XCRUN_INFO_FLAGS = [
  '--version',
  '--show-sdk-path',
  '--show-sdk-version',
  '--show-sdk-build-version',
  '--show-sdk-platform-path',
  '--show-sdk-platform-version',
];

/** A program limited to a fixed list of subcommands (plus --version). */
function subcommands(name: string, allowed: string[]): Rule {
  return (args) => {
    const [sub, ...rest] = args;
    if (sub === undefined) return `${name} needs a subcommand`;
    if (sub === '--version') return rest.length ? `${name} --version takes no arguments` : null;
    return allowed.includes(sub)
      ? null
      : `${name} ${sub} is not allowed (allowed: ${allowed.join(', ')})`;
  };
}

function interpreter(name: string): Rule {
  return (args, { cwd }) => {
    if (args.length === 1 && ['--version', '-V'].includes(args[0])) return null;
    const [script] = args;
    if (script === undefined) return `${name} needs a script file (REPL and stdin are not allowed)`;
    if (script.startsWith('-'))
      return `${name} options are not allowed; the first argument must be a script file`;
    const path = resolve(cwd, script);
    if (!existsSync(path) || !statSync(path).isFile())
      return `${name} script not found in the workspace: ${script}`;
    return null;
  };
}

const RULES: Record<string, Rule> = {
  pnpm: subcommands('pnpm', ['test', 't', 'run', 'ls', 'list']),
  yarn: subcommands('yarn', ['test', 'run', 'list']),
  cargo: subcommands('cargo', ['test', 'build', 'check', 'clippy', 'fmt']),
  go: subcommands('go', ['test', 'build', 'vet']),
  pytest: () => null,
  pwd: () => null,
  ls: () => null,
  mkdir: () => null,
  find: (args) => {
    const bad = args.find((a) => FIND_ACTIONS.includes(a) || FIND_WRITERS.includes(a));
    return bad ? `find ${bad} can delete files, run programs or write files` : null;
  },
  // Linters and formatters: paths are checked like every argument; config files can't name
  // programs to run. swiftlint's analyze runs a compiler log through sourcekit; not needed.
  swiftlint: (args) =>
    args[0] === undefined || ['lint', 'version', 'rules'].includes(args[0])
      ? null
      : `swiftlint ${args[0]} is not allowed (allowed: lint, version, rules)`,
  swiftformat: () => null,
  rg: (args) => (hasFlag(args, ['--pre']) ? 'rg --pre runs an arbitrary program' : null),
  git: (args, { cwd }) => {
    const [sub, ...rest] = args;
    if (sub === undefined) return null;
    if (sub === '--version') return rest.length ? 'git --version takes no arguments' : null;
    if (sub.startsWith('-'))
      return `git global options (${sub}) are not allowed; put the subcommand first`;
    if (!GIT_SUBCOMMANDS.includes(sub))
      return `git ${sub} is not allowed (allowed: ${GIT_SUBCOMMANDS.join(', ')})`;
    if (hasFlag(rest, ['--output'])) return 'git --output is not allowed';
    if (sub === 'grep' && rest.some((a) => shortCluster(a, 'O') || a.startsWith('--open-files')))
      return 'git grep -O runs a pager program';
    // agentbelt deletes its own task branches when a task is discarded; nothing else.
    if (sub === 'branch' && ['-D', '-d', '--delete'].includes(rest[0] ?? ''))
      return rest.length === 2 && /^agentbelt\/[A-Za-z0-9._-]+$/.test(rest[1])
        ? null
        : 'git branch may only delete agentbelt/<task> branches';
    if (
      sub === 'branch' &&
      rest.some(
        (a) =>
          shortCluster(a, 'dDmMcCf') ||
          ['--delete', '--move', '--copy', '--force', '--edit-description'].includes(flagName(a)),
      )
    )
      return 'git branch may only list or create branches';
    if (sub === 'init' && hasFlag(rest, ['--template', '--separate-git-dir']))
      return 'git init --template/--separate-git-dir is not allowed';
    if (sub === 'worktree' && rest[0] === 'remove') {
      const paths = rest.slice(1).filter((a) => a !== '--force');
      const target = paths.length === 1 ? resolve(cwd, paths[0]) : '';
      return paths.length === 1 && /[\\/]\.agentbelt[\\/]worktrees[\\/][^\\/]+$/.test(target)
        ? null
        : 'git worktree remove only removes .agentbelt/worktrees/<task>';
    }
    if (sub === 'worktree' && !['add', 'list'].includes(rest[0] ?? ''))
      return 'git worktree only allows add, list, and removing agentbelt task worktrees';
    return null;
  },
  npm: (args) => {
    const [sub, ...rest] = args;
    if (sub === undefined) return null;
    if (sub === '--version' || sub === '-v')
      return rest.length ? 'npm --version takes no arguments' : null;
    return NPM_SUBCOMMANDS.includes(sub)
      ? null
      : `npm ${sub} is not allowed (allowed: ${NPM_SUBCOMMANDS.join(', ')})`;
  },
  node: interpreter('node'),
  python3: interpreter('python3'),
  swift: (args) => {
    const [sub, ...rest] = args;
    if (sub === '--version') return rest.length ? 'swift --version takes no arguments' : null;
    if (!SWIFT_SUBCOMMANDS.includes(sub ?? ''))
      return `swift ${sub ?? '(REPL)'} is not allowed (allowed: ${SWIFT_SUBCOMMANDS.join(', ')})`;
    if (sub === 'package' && !SWIFT_PACKAGE_SUBCOMMANDS.includes(rest[0] ?? ''))
      return `swift package ${rest[0] ?? ''} is not allowed (allowed: ${SWIFT_PACKAGE_SUBCOMMANDS.join(', ')})`;
    const bad = hasFlag(rest, SWIFT_DENIED_FLAGS);
    return bad ? `swift ${flagName(bad)} is not allowed` : null;
  },
  xcodebuild: (args) => {
    const bad = hasFlag(args, XCODEBUILD_DENIED_FLAGS);
    return bad ? `xcodebuild ${flagName(bad)} is not allowed` : null;
  },
  xcrun: (args) => {
    // Read-only result and coverage readers for .xcresult bundles.
    if (args[0] === 'xcresulttool')
      return args[1] === 'get' || args[1] === 'version'
        ? null
        : 'xcrun xcresulttool only allows get (read-only)';
    if (args[0] === 'xccov')
      return args[1] === 'view' ? null : 'xcrun xccov only allows view (read-only)';
    if (args[0] === 'simctl') {
      const sub = args[1] ?? '';
      if (!SIMCTL_SUBCOMMANDS.includes(sub))
        return `xcrun simctl ${sub} is not allowed (allowed: ${SIMCTL_SUBCOMMANDS.join(', ')})`;
      if (sub === 'io' && !['screenshot', 'enumerate'].includes(args[3] ?? ''))
        return 'xcrun simctl io only allows screenshot and enumerate';
      return null;
    }
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--sdk') i++;
      else if (!XCRUN_INFO_FLAGS.includes(args[i]))
        return 'xcrun may only run simctl, xcresulttool get, xccov view, or print SDK information';
    }
    return null;
  },
};

export const ALLOWED_PROGRAMS = Object.keys(RULES);

export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves `path` the way the kernel does: component by component, following each symlink
 * before applying a later `..`. Missing tail components are kept as written. Throws for a
 * dangling symlink.
 */
function canonical(path: string): string {
  let current: string = sep;
  let missing = false;
  for (const part of path.split(sep)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!missing) {
      try {
        current = lstatSync(next).isSymbolicLink() ? realpathSync(next) : next;
        continue;
      } catch (error) {
        if (lstatOk(next)) throw error;
        missing = true;
      }
    }
    current = next;
  }
  return current;
}
function lstatOk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The argument itself, plus the value of `--opt=value` and `KEY=value` forms. */
function pathCandidates(arg: string): string[] {
  const eq = arg.indexOf('=');
  if (eq > 0 && (arg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)))
    return [arg, arg.slice(eq + 1)];
  return [arg];
}

export function checkPath(root: string, cwd: string, arg: string): string | null {
  for (const value of pathCandidates(arg)) {
    if (!value) continue;
    let real: string;
    try {
      real = canonical(isAbsolute(value) ? value : `${cwd}${sep}${value}`);
    } catch {
      return `unresolvable path (dangling symlink?): ${arg}`;
    }
    const lexical = resolve(cwd, value);
    if (!inside(root, real))
      return inside(root, lexical)
        ? `path escapes the workspace through a symlink: ${arg}`
        : `path outside workspace: ${arg}`;
    const rels = [relative(root, real)];
    if (inside(root, lexical)) rels.push(relative(root, lexical));
    for (const rel of rels) {
      const parts = rel.split(sep);
      if (parts.includes('.git')) return `arguments may not refer to .git: ${arg}`;
      // agentbelt's own state; only task worktrees and saved workflows are reachable.
      if (parts[0] === '.agentbelt' && !['worktrees', 'workflows'].includes(parts[1]))
        return `arguments may not refer to .agentbelt: ${arg}`;
    }
  }
  return null;
}

/**
 * Checks one command against the policy. Returns the denial reason, or null if it may run.
 * `root` is the workspace; `cwd` must be inside it.
 */
export function checkCommand(
  root: string,
  cwd: string,
  command: string,
  args: string[],
): string | null {
  const rootReal = realpathSync(root);
  let cwdReal: string;
  try {
    cwdReal = realpathSync(resolve(cwd));
  } catch {
    return `working directory does not exist: ${cwd}`;
  }
  if (!inside(rootReal, cwdReal)) return `working directory outside workspace: ${cwd}`;
  const rule = Object.hasOwn(RULES, command) ? RULES[command] : undefined;
  if (!rule) return `${command} is not an allowed program`;
  if ([command, ...args].some((a) => a.includes('\0'))) return 'arguments contain a NUL byte';
  for (const arg of args) {
    const reason = checkPath(rootReal, cwdReal, arg);
    if (reason) return reason;
  }
  return rule(args, { cwd: cwdReal });
}

/** Limit for one command (test suites can be slow). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Per-stream output kept in memory; the rest is counted and dropped. */
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

/**
 * Runs a command that already passed checkCommand: argv only (no shell), its own process group,
 * stdin closed, a minimal environment, bounded output and a timeout that kills the whole group.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const out: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const kept = { stdout: 0, stderr: 0 };
    let truncated = false;
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = MAX_COMMAND_OUTPUT_BYTES - kept[stream];
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      out[stream].push(part);
      kept[stream] += part.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Group already gone.
      }
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        timers.push(setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS));
        timers.push(setTimeout(() => finish(null, null), KILL_GRACE_MS * 2));
      }, timeoutMs),
    );
    const decode = (parts: Buffer[]) => {
      const text = Buffer.concat(parts).toString();
      return truncated ? text.replace(/\uFFFD$/, '') : text;
    };
    const finish = (exitCode: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      let stderr = decode(out.stderr) + (error ? error.message : '');
      if (truncated)
        stderr += `\n[agentbelt: output truncated at ${MAX_COMMAND_OUTPUT_BYTES} bytes per stream]`;
      if (timedOut) stderr += `\n[agentbelt: killed after ${timeoutMs} ms timeout]`;
      resolveResult({
        command,
        args,
        cwd,
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        stdout: decode(out.stdout),
        stderr,
        durationMs: Date.now() - started,
        ...(timedOut ? { timedOut: true } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    };
    child.on('close', (exitCode) => finish(exitCode, null));
    child.on('error', (error) => finish(1, error));
  });
}
