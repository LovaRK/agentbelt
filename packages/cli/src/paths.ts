// Where agentbelt keeps its installed versions and state (overridable with AGENTBELT_HOME):
//   versions/<version>/   one npm install per version (scripts disabled)
//   current -> versions/<version>   switched atomically
//   bin/agentbelt         the shim every client config runs
//   state.json            { current, previous }
//   backups/              client config copies taken before each change
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const home = () =>
  process.env.AGENTBELT_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agentbelt');
export const versionsDir = () => join(home(), 'versions');
export const currentLink = () => join(home(), 'current');
export const shimPath = () => join(home(), 'bin', 'agentbelt');
export const stateFile = () => join(home(), 'state.json');
export const backupsDir = () => join(home(), 'backups');

/** This package's own directory (packages/cli in the repo, node_modules/agentbelt when installed). */
export const packageDir = () => fileURLToPath(new URL('..', import.meta.url));
export const skillsDir = () => join(packageDir(), 'skills');
export const pluginsDir = () => join(home(), 'plugins');
export const grantsFile = () => join(home(), 'grants.json');
