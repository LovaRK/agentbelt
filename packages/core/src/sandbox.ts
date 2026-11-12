// OS isolation for untrusted (third-party) plugins. They run in a separate Node process inside a
// sandbox that denies by default: no network, no writes except /dev/null, no reads outside the
// plugin's own folder, the plugin host and the Node runtime, and no other programs. Their only
// way to act on the project is the broker channel to the parent, where every request is checked
// against the plugin's grant and audited.
//
// Backends:
// - macOS: `sandbox-exec` (deprecated by Apple but still shipped and enforced).
// - Linux: bubblewrap (`bwrap`), using unprivileged user namespaces. It is used only after a probe
//   run succeeds on this machine (some distributions restrict user namespaces).
// Anything else has no backend, and untrusted plugins are refused there (fail closed):
// agentbelt never falls back to running untrusted code with only policy checks.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface SandboxBackend {
  name: 'macos-sandbox-exec' | 'linux-bubblewrap';
  /** Starts `node <args>` inside the sandbox, allowed to read only `readPaths`. */
  spawnNode(args: string[], readPaths: string[]): ChildProcess;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The available backend, or null (untrusted plugins are then refused). */
export function sandboxBackend(): SandboxBackend | null {
  if (process.env.AGENTBELT_DISABLE_SANDBOX === '1') return null; // tests: simulate no backend
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) return macos();
  if (process.platform === 'linux') return linux();
  return null;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Every dynamic library the Node binary loads, followed recursively (macOS otool). */
function nodeLibraries(node: string): string[] {
  const seen = new Set<string>();
  const queue = [node];
  while (queue.length) {
    const file = queue.pop()!;
    let out = '';
    try {
      out = execFileSync('otool', ['-L', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const line of out.split('\n').slice(1)) {
      let lib = line.trim().split(' ')[0];
      if (!lib || lib.startsWith('/usr/lib/') || lib.startsWith('/System/')) continue;
      if (lib.startsWith('@')) {
        // @rpath/@loader_path: next to the loading library, or in the Node prefix's lib folder.
        const name = lib.replace(/^@(rpath|loader_path|executable_path)\//, '');
        lib =
          [resolve(dirname(file), name), resolve(dirname(node), '..', 'lib', name)].find((c) =>
            existsSync(c),
          ) ?? '';
      }
      if (!isAbsolute(lib) || seen.has(lib)) continue;
      seen.add(lib);
      seen.add(real(lib));
      queue.push(real(lib));
    }
  }
  return [...seen];
}

const q = (s: string) => JSON.stringify(s); // SBPL strings use the same escaping as JSON

export function macosProfile(node: string, readPaths: string[]): string {
  const nodeReal = real(node);
  const prefix = dirname(dirname(nodeReal));
  const reads = [
    ...readPaths.map((p) => `(subpath ${q(real(p))})`),
    `(subpath ${q(prefix)})`,
    ...nodeLibraries(nodeReal).map((l) => `(literal ${q(l)})`),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (literal ${q(nodeReal)}))`,
    '(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System") (subpath "/Library/Apple")',
    '  (subpath "/private/var/db/dyld") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")',
    '  (literal "/private/etc/localtime") (subpath "/private/var/db/timezone") (subpath "/usr/share/icu")',
    `  ${reads.join('\n  ')})`,
    '(allow file-read-metadata)',
    '(allow file-write* (literal "/dev/null"))',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata)',
    '(allow signal (target self))',
    '(deny network*)',
    '',
  ].join('\n');
}

// Same environment for every backend: no inherited secrets, only a minimal set of variables.
const MINIMAL_ENV = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  NODE_OPTIONS: '',
  OPENSSL_CONF: '/dev/null',
};

function macos(): SandboxBackend {
  return {
    name: 'macos-sandbox-exec',
    spawnNode(args, readPaths) {
      const node = process.execPath;
      return spawn(SANDBOX_EXEC, ['-p', macosProfile(node, readPaths), real(node), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // No inherited secrets: the plugin sees only a minimal environment.
        env: MINIMAL_ENV,
      });
    },
  };
}

// ---------------------------------------------------------------- Linux: bubblewrap

const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];

/** The shared libraries the Node binary loads (from `ldd`), plus the dynamic loader. */
function linuxLibraries(node: string): string[] {
  let out = '';
  try {
    out = execFileSync('ldd', [node], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const libs = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/(?:=>\s*)?(\/\S+)\s+\(0x/);
    if (m) {
      libs.add(m[1]);
      libs.add(real(m[1]));
    }
  }
  return [...libs];
}

/**
 * bubblewrap arguments. The sandbox starts from an empty root and only gets, read-only: the Node
 * binary (or its install folder when that is not a system folder), the exact libraries it loads,
 * and `readPaths`. There is no shell or other program to run, no network (own network namespace),
 * no view of other processes, and the whole root is remounted read-only, so nothing can be written.
 */
export function bubblewrapArgs(node: string, readPaths: string[], libraries: string[]): string[] {
  const nodeReal = real(node);
  const prefix = dirname(dirname(nodeReal));
  // A Node install folder such as /opt/node or ~/.nvm/versions/node/v24 holds only Node and its
  // scripts; /usr or / would expose every system program, so then only the binary is mounted.
  const system = prefix === '/' || prefix === '/usr' || prefix === '/usr/local';
  const ro = new Set<string>([
    ...(system ? [nodeReal] : [prefix]),
    ...libraries,
    ...readPaths.map(real),
  ]);
  const args = [
    '--unshare-all', // user, pid, network, ipc, uts and cgroup namespaces
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind-try',
    '/etc/ld.so.cache',
    '/etc/ld.so.cache',
    '--ro-bind-try',
    '/etc/localtime',
    '/etc/localtime',
  ];
  for (const p of [...ro].sort()) args.push('--ro-bind', p, p);
  if (system && node !== nodeReal) args.push('--ro-bind', nodeReal, node);
  args.push('--remount-ro', '/', '--chdir', '/');
  return args;
}

let linuxProbe: SandboxBackend | null | undefined;

function linux(): SandboxBackend | null {
  if (linuxProbe !== undefined) return linuxProbe;
  const bwrap = BWRAP_PATHS.find((p) => existsSync(p));
  if (!bwrap) return (linuxProbe = null);
  const node = process.execPath;
  const libs = linuxLibraries(real(node));
  const backend: SandboxBackend = {
    name: 'linux-bubblewrap',
    spawnNode(args, readPaths) {
      return spawn(bwrap, [...bubblewrapArgs(node, readPaths, libs), '--', real(node), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: MINIMAL_ENV,
      });
    },
  };
  // Only use bubblewrap if it actually works here: user namespaces may be disabled or restricted
  // (e.g. by AppArmor), and then the plugin would not start. Fail closed instead.
  const probe = spawnSync(
    bwrap,
    [...bubblewrapArgs(node, [], libs), '--', real(node), '-e', 'process.exit(7)'],
    { env: MINIMAL_ENV, timeout: 10_000, stdio: 'ignore' },
  );
  return (linuxProbe = probe.status === 7 ? backend : null);
}
