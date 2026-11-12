// The environment a child command sees. Only variables that tools need to work (paths, locale,
// toolchain locations, git identity) pass through; tokens and keys in the user's shell do not.
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'DEVELOPER_DIR',
  'SDKROOT',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'JAVA_HOME',
  'GOPATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

/** Fixed settings so nothing waits for input or opens an editor or pager. */
const FIXED = {
  CI: '1',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
};

/**
 * Builds a child environment from `source`: the allowlist plus `extra` names the caller opted
 * into, then the fixed settings. NODE_OPTIONS and similar injection points are never passed.
 */
export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...PASSTHROUGH, ...extra])
    if (source[name] !== undefined) env[name] = source[name];
  return { ...env, ...FIXED };
}
