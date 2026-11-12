#!/usr/bin/env node
// agentbelt CLI. `setup` installs a pinned, verified copy and connects your AI apps; `serve` is
// what those apps run. Workflow approvals are decided here, never through MCP tools.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  createAgentbeltServer,
  GrantStore,
  grantPlugin,
  loadExternal,
  projectRoot,
  refusal,
  sandboxBackend,
  serveStdio,
  stagePlugin,
  type Plugin,
} from '@agentbelt/core';
import { decide, describe, execute, getRun, listRuns } from '@agentbelt/plugin-workflows';
import { allAdapters, backup, onPath, type ClientAdapter } from './adapters.js';
import {
  activate,
  activeVersion,
  readState,
  rollback,
  stage,
  verify,
  versionOf,
  writeShim,
} from './install.js';
import {
  currentLink,
  grantsFile,
  home,
  packageDir,
  pluginsDir,
  shimPath,
  skillsDir,
} from './paths.js';
import { FIRST_PARTY } from './plugins.js';

const VERSION: string = JSON.parse(
  readFileSync(join(packageDir(), 'package.json'), 'utf8'),
).version;
const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const say = (s = ''): void => void process.stderr.write(`${s}\n`); // stdout is reserved for `serve`
const out = (s: string): void => void process.stdout.write(`${s}\n`);

async function confirm(question: string): Promise<boolean> {
  if (has('--yes') || has('-y')) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

function server(workspace?: string) {
  return createAgentbeltServer({
    version: VERSION,
    plugins: FIRST_PARTY,
    workspace: workspace ?? projectRoot(process.cwd()),
    skillsDirs: [skillsDir()],
  });
}

function selectedAdapters(): ClientAdapter[] {
  const only = flag('--clients')?.split(',');
  return allAdapters().filter((a) => !only || only.includes(a.id));
}

/** Installs (or reuses) a verified version and makes it current. */
async function installStep(): Promise<void> {
  const from = flag('--from');
  const specs = from ? readdirTgz(resolve(from)) : [`agentbelt@${flag('--to') ?? VERSION}`];
  const target = from ? 'local packages' : specs[0];
  const active = activeVersion();
  if (!from && active === (flag('--to') ?? VERSION) && !has('--reinstall')) {
    say(`✓ agentbelt ${active} is already installed and active`);
    return;
  }
  say(`• Installing ${target} (lifecycle scripts disabled)…`);
  const staged = stage(specs);
  say(`• Verifying ${versionOf(staged)} before activating it…`);
  try {
    for (const line of await verify(staged)) say(`    ✓ ${line}`);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`verification failed, nothing was changed: ${(error as Error).message}`);
  }
  const state = activate(staged);
  writeShim();
  say(
    `✓ agentbelt ${state.current ?? activeVersion()} is active${state.previous ? ` (previous: ${state.previous}, kept for rollback)` : ''}`,
  );
}

function readdirTgz(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (!files.length) throw new Error(`no .tgz packages in ${dir}`);
  return files.map((f) => join(dir, f));
}

async function connectClients(): Promise<void> {
  const entry = { command: shimPath(), args: ['serve'] };
  const found = selectedAdapters().filter((a) => a.detect());
  if (!found.length) {
    say('No supported AI apps found (DeepSeek Harness, Claude Code, Codex). You can still add');
    say(`this server to any MCP client: command ${entry.command}, args ["serve"].`);
    return;
  }
  for (const a of found) {
    if (a.isInstalled() && !has('--reconnect')) {
      say(`✓ ${a.label}: already connected`);
      continue;
    }
    say(`\n${a.label} — will ${a.describe(entry)}`);
    if (!(await confirm(`Connect ${a.label}?`))) {
      say(`  skipped ${a.label}`);
      continue;
    }
    const copy = backup(a.configFile(), a.id);
    a.add(entry);
    say(`✓ ${a.label} connected${copy ? ` (backup: ${copy})` : ''}`);
  }
}

async function doctor(): Promise<boolean> {
  let healthy = true;
  const check = (okay: boolean, text: string) => {
    say(`${okay ? '✓' : '✗'} ${text}`);
    if (!okay) healthy = false;
  };
  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 22, `Node ${process.versions.node} (needs 22.13+)`);
  check(!!onPath('git'), 'git is installed');
  const active = activeVersion();
  check(
    !!active,
    active
      ? `active version ${active} (previous: ${readState().previous ?? 'none'})`
      : 'no installed version — run: npx agentbelt setup',
  );
  for (const a of allAdapters())
    if (a.detect())
      say(
        `${a.isInstalled() ? '✓' : '·'} ${a.label}: ${a.isInstalled() ? 'connected' : 'detected, not connected'}`,
      );
  if (active) {
    say('• Real tool calls through the installed server (the same command your apps run):');
    try {
      for (const line of await verify(currentLink())) say(`    ✓ ${line}`);
    } catch (error) {
      check(false, `server check failed: ${(error as Error).message}`);
    }
  }
  say(
    '• Command isolation: policy-only (permission + command checks; agentbelt does not claim an OS sandbox for first-party tools)',
  );
  return healthy;
}

async function workflowCommand(): Promise<void> {
  const { contextFor } = server(flag('--workspace'));
  const ctx = await contextFor('workflows');
  if (command === 'runs') {
    for (const r of listRuns(ctx).slice(0, 20))
      out(`${r.id}  ${r.state.padEnd(16)} ${r.workflow}  ${r.updatedAt}`);
    return;
  }
  const run = getRun(ctx, args[0] ?? '');
  if (!run) throw new Error(`no run ${args[0] ?? ''} (see: agentbelt runs)`);
  if (command === 'show') return out(describe(run));
  const step = args[1];
  if (!step) throw new Error(`usage: agentbelt ${command} <run> <step> [--note "…"]`);
  decide(run, step, command === 'approve', flag('--note') ?? '');
  const done = await execute(ctx, run, ctx.listTools());
  out(describe(done));
}

async function pluginCommand(): Promise<void> {
  const sub = args.shift();
  const grants = new GrantStore(grantsFile());
  if (sub === 'list' || !sub) {
    say(
      `OS sandbox for third-party plugins: ${sandboxBackend()?.name ?? 'NOT AVAILABLE — third-party plugins are refused on this system'}`,
    );
    for (const p of FIRST_PARTY)
      out(
        `${p.name.padEnd(14)} ${p.version.padEnd(8)} built-in   ${JSON.stringify(p.permissions)}`,
      );
    for (const g of grants.all())
      out(
        `${g.name.padEnd(14)} ${g.version.padEnd(8)} third-party ${JSON.stringify(g.permissions)}${refusal(g) ? `  REFUSED: ${refusal(g)}` : ''}`,
      );
    return;
  }
  if (sub === 'add') {
    const spec = args.find((a) => !a.startsWith('-'));
    if (!spec) throw new Error('usage: agentbelt plugin add <npm-package | ./plugin.tgz>');
    say(`• Downloading ${spec} with install scripts disabled (no plugin code runs yet)…`);
    const m = stagePlugin(spec, pluginsDir());
    say(`\nThird-party plugin "${m.name}" ${m.version} asks for:`);
    say(
      `  run programs: ${(m.permissions.exec ?? []).join(', ') || 'none'} (each still checked by the command policy)`,
    );
    say(
      `  read project files: ${m.permissions.read ? 'yes' : 'no'}   write project files: ${m.permissions.write ? 'yes' : 'no'}   call other tools: ${m.permissions.callTools ? 'yes' : 'no'}`,
    );
    say(
      '  Its code runs in an OS sandbox: no network, no access to your files outside its own folder.',
    );
    if (!(await confirm(`Grant these permissions to ${m.name}?`))) {
      rmSync(m.dir, { recursive: true, force: true });
      return say('Not installed.');
    }
    const g = grantPlugin(m, pluginsDir(), grants);
    return say(
      `✓ ${g.name} ${g.version} granted (pinned to sha256 ${g.hash.slice(0, 12)}…). Restart your AI app to load it.`,
    );
  }
  if (sub === 'remove') {
    const name = args[0];
    if (!grants.all().some((g) => g.name === name))
      throw new Error(`no third-party plugin ${name}`);
    grants.remove(name);
    rmSync(join(pluginsDir(), name), { recursive: true, force: true });
    return say(`✓ removed ${name}`);
  }
  throw new Error('usage: agentbelt plugin list | add <spec> | remove <name>');
}

const HELP = `agentbelt ${VERSION} — safe git, testing and workflow tools for any MCP client

  setup [--yes] [--clients deepseek,claude-code,codex] [--from <dir-with-.tgz>]
                     install a verified copy and connect your AI apps
  doctor             check the install and make real tool calls through it
  update [--to <version>] [--from <dir>]
                     install, verify, then switch atomically (old version kept)
  rollback           switch back to the previous version
  uninstall [--yes]  remove agentbelt from your AI apps (config backups are kept)
  serve [--workspace <dir>]   the MCP server (what your apps run)
  plugin list | add <npm-package|file.tgz> | remove <name>
                     third-party plugins: install scripts disabled, run only in an OS sandbox

  runs | show <run>  workflow runs in this project
  approve <run> <step> [--note "…"] | reject <run> <step>
                     decide an approval gate (only possible here, never via AI tools)
  audit [--n 20]     recent audit log entries for this project
`;

async function main() {
  switch (command) {
    case 'serve': {
      // Third-party plugins load only inside the OS sandbox and only if unchanged since granted.
      const external: Plugin[] = [];
      const notices: string[] = [];
      for (const g of new GrantStore(grantsFile()).all()) {
        const why = refusal(g);
        if (why) {
          notices.push(`third-party plugin ${g.name} not loaded: ${why}`);
          continue;
        }
        try {
          external.push(await loadExternal(g));
        } catch (error) {
          notices.push((error as Error).message);
        }
      }
      return serveStdio({
        version: VERSION,
        plugins: [...FIRST_PARTY, ...external],
        workspace: flag('--workspace') ?? process.env.AGENTBELT_WORKSPACE,
        skillsDirs: [skillsDir()],
        notices,
      });
    }
    case 'plugin':
      return pluginCommand();
    case 'setup':
      say(`agentbelt ${VERSION} setup\n`);
      await installStep();
      await connectClients();
      say('');
      if (!(await doctor())) process.exitCode = 1;
      say('\nNext: open your AI app in a project and ask it to "use agentbelt to run the checks".');
      return;
    case 'doctor':
      if (!(await doctor())) process.exitCode = 1;
      return;
    case 'update': {
      const to = flag('--to') ?? (flag('--from') ? undefined : await latestVersion());
      if (to && to === activeVersion() && !has('--reinstall')) return say(`✓ already on ${to}`);
      say(
        `Update ${activeVersion() ?? '(none)'} → ${to ?? 'local packages'}. Release notes: https://github.com/agentbelt/agentbelt/releases`,
      );
      if (
        !(await confirm(
          'Install and verify it now? (your current version stays active until verification passes)',
        ))
      )
        return;
      if (to) args.push('--to', to);
      return installStep();
    }
    case 'rollback': {
      const s = rollback();
      return say(
        `✓ switched to ${s.current} (newer version ${s.previous} kept; \`agentbelt rollback\` again to return)`,
      );
    }
    case 'uninstall':
      for (const a of allAdapters())
        if (a.detect() && a.isInstalled() && (await confirm(`Remove agentbelt from ${a.label}?`))) {
          const copy = backup(a.configFile(), a.id);
          a.remove();
          say(`✓ removed from ${a.label}${copy ? ` (backup: ${copy})` : ''}`);
        }
      return say(`Installed versions remain in ${home()}; delete that folder to remove them.`);
    case 'runs':
    case 'show':
    case 'approve':
    case 'reject':
      return workflowCommand();
    case 'audit': {
      const { AuditLog } = await import('@agentbelt/core');
      for (const e of new AuditLog(projectRoot(flag('--workspace') ?? process.cwd())).tail(
        Number(flag('--n') ?? 20),
      ))
        out(
          `${e.ts}  ${(e.client ?? '').padEnd(14)} ${e.kind.padEnd(6)} ${e.ok ? 'ok ' : 'NO '} ${e.plugin}${e.tool ? `/${e.tool}` : ''}  ${e.detail}`,
        );
      return;
    }
    case 'version':
    case '--version':
      return out(VERSION);
    default:
      return out(HELP);
  }
}

async function latestVersion(): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('npm', ['view', 'agentbelt', 'version'], { encoding: 'utf8' }).trim();
}

main().catch((error: Error) => {
  say(`error: ${error.message}`);
  process.exit(1);
});
