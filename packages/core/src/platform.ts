// Platform differences in one place. agentbelt never uses a shell to run a program, which on
// Windows means:
//   - a program is found on PATH with its PATHEXT extension (git → git.exe);
//   - .cmd/.bat files can only run through cmd.exe, whose quoting can't be made safe for
//     arbitrary arguments, so they are refused. npm and npx are .cmd wrappers around JavaScript
//     files that ship next to node.exe, so those run as `node npm-cli.js …` instead;
//   - POSIX tools that Windows has under the same name with different meaning (find) or not at
//     all (ls, pwd) are refused;
//   - a process tree is stopped with taskkill, since Windows has no process groups to signal.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * Real path with symlinks (and junctions) resolved. On Windows the native call also expands
 * 8.3 short names (PROGRA~1) and fixes letter case, so two spellings of one folder compare equal.
 */
export const realPath = (path: string): string =>
  isWindows ? realpathSync.native(path) : realpathSync(path);

/** Programs that mean something else on Windows, or that Windows doesn't have. */
const POSIX_ONLY = ['find', 'ls', 'pwd', 'mkdir'];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Finds `name` on PATH, trying each PATHEXT extension on Windows. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? '';
  const exts = isWindows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** npm's own JavaScript entry (npm-cli.js or npx-cli.js) for the Node running agentbelt. */
export function npmScript(which: 'npm' | 'npx', env: NodeJS.ProcessEnv = process.env): string {
  const file = `${which}-cli.js`;
  const candidates = [
    env.npm_execpath ? join(dirname(env.npm_execpath), file) : '',
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', file),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', file),
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error(`cannot find ${file} next to ${process.execPath}`);
  return found;
}

export interface Launch {
  file: string;
  args: string[];
}

/**
 * How to start `command args` without a shell on this platform. Throws with a clear reason when
 * the program can't be started safely here.
 */
export function launchFor(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Launch {
  if (!isWindows) return { file: command, args };
  if (command === 'npm' || command === 'npx')
    return { file: process.execPath, args: [npmScript(command, env), ...args] };
  if (POSIX_ONLY.includes(command)) throw new Error(`${command} is not available on Windows`);
  const file = isAbsolute(command) ? command : findOnPath(command, env);
  if (!file) throw new Error(`${command} was not found on PATH`);
  const ext = extname(file).toLowerCase();
  if (ext === '.cmd' || ext === '.bat')
    throw new Error(
      `${command} is a ${ext} script (${file}); agentbelt runs programs without a shell, so ` +
        'Windows batch files are not supported',
    );
  return { file, args };
}

/** Stops a process and everything it started. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}
