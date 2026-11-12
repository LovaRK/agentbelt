// OS isolation for untrusted (third-party) plugins. They run in a separate Node process inside a
// sandbox that denies by default: no network, no writes except /dev/null, no reads outside the
// plugin's own folder, the plugin host and the Node runtime, and no other programs. Their only
// way to act on the project is the broker channel to the parent, where every request is checked
// against the plugin's grant and audited.
//
// Backends: macOS `sandbox-exec` (deprecated by Apple but still shipped and enforced).
// Anything else has no backend in v0.1, and untrusted plugins are refused there (fail closed):
// agentbelt never falls back to running untrusted code with only policy checks.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface SandboxBackend {
  name: 'macos-sandbox-exec';
  /** Starts `node <args>` inside the sandbox, allowed to read only `readPaths`. */
  spawnNode(args: string[], readPaths: string[]): ChildProcess;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The available backend, or null (untrusted plugins are then refused). */
export function sandboxBackend(): SandboxBackend | null {
  if (process.env.AGENTBELT_DISABLE_SANDBOX === '1') return null; // tests: simulate no backend
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) return macos();
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

function macos(): SandboxBackend {
  return {
    name: 'macos-sandbox-exec',
    spawnNode(args, readPaths) {
      const node = process.execPath;
      return spawn(SANDBOX_EXEC, ['-p', macosProfile(node, readPaths), real(node), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // No inherited secrets: the plugin sees only a minimal environment.
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          NODE_OPTIONS: '',
          OPENSSL_CONF: '/dev/null',
        },
      });
    },
  };
}
