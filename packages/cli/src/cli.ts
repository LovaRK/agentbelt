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
  ProjectState,
  STATUSES,
  statusReport,
  resumeReport,
  contextView,
  readContext,
  recordContext,
  fromClaudeStatusline,
  discoverModels,
  saveRegistry,
  loadRegistry,
  route,
  type Status,
  type TaskKind,
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
import { agentCommand, loadAgent } from './agent.js';
import { scheduleCommand } from './scheduler-cli.js';

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
  const base = { command: shimPath(), args: ['serve'] };
  const entry = base;
  const found = selectedAdapters().filter((a) => a.detect());
  if (!found.length) {
    say(
      'No supported AI apps found (DeepSeek Harness, Claude Code, Codex, Cursor, VS Code, Claude Desktop, LM Studio). You can still add',
    );
    say(`this server to any MCP client: command ${entry.command}, args ["serve"].`);
    return;
  }
  const workspace = flag('--workspace');
  for (const a of found) {
    if (a.needsWorkspace && !workspace) {
      say(`• ${a.label}: skipped — it does not tell servers which project is open.`);
      say(`  Re-run with --workspace <project-dir> to connect it to one project.`);
      continue;
    }
    const entry = a.needsWorkspace
      ? { ...base, args: ['serve', '--workspace', resolve(workspace!)] }
      : base;
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

/** Initial milestone matrix. Everything starts NOT_STARTED; status changes need evidence. */
const MILESTONES: [string, string, string, string[]][] = [
  ['M0', 'Repository inspection', 'audit of files, commits and tests recorded', []],
  ['M1', 'Core MCP server', 'integration tests pass', ['M0']],
  ['M2', 'Plugin SDK', 'unit tests pass', ['M1']],
  ['M3', 'Permission broker', 'security tests pass', ['M2']],
  ['M4', 'Git plugin', 'real tool execution', ['M3']],
  ['M5', 'Testing plugin', 'real tool execution', ['M3']],
  ['M6', 'Workflow plugin', 'workflow run results', ['M4', 'M5']],
  ['M7', 'CLI installer', 'fresh installation verified', ['M6']],
  ['M8', 'Claude Code integration', 'real calls in audit log', ['M7']],
  ['M9', 'Codex integration', 'real calls in audit log', ['M7']],
  ['M10', 'DeepSeek integration', 'real MCP execution in audit log', ['M7']],
  ['M11', 'Security hardening', 'security tests pass', ['M3']],
  ['M12', 'Documentation and release', 'release checklist complete', ['M8', 'M9', 'M10', 'M11']],
];

function project() {
  return new ProjectState(
    projectRoot(flag('--workspace') ?? process.cwd()),
    flag('--name') ?? 'project',
  );
}
const listFlag = (name: string) =>
  flag(name)
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

async function progressCommand(): Promise<void> {
  const sub = args.shift() ?? 'list';
  const ps = project();
  if (sub === 'init') {
    if (ps.exists() && !has('--force')) return say(`project state already exists in ${ps.dir}`);
    for (const [id, title, criteria, dependsOn] of MILESTONES)
      ps.upsert({ id, title, criteria, dependsOn });
    ps.update('init', (st) => {
      st.project = flag('--name') ?? st.project;
      st.version = flag('--version') ?? st.version;
    });
    return say(`✓ initialized ${ps.dir} (all milestones NOT_STARTED until evidence is recorded)`);
  }
  if (sub === 'list') {
    for (const i of ps.load().items)
      out(
        `${i.id.padEnd(6)} ${i.status.padEnd(23)} ${i.title}${i.evidence.length ? `  — ${i.evidence.at(-1)!.text.slice(0, 80)}` : ''}`,
      );
    return;
  }
  if (sub === 'add') {
    const [id, ...title] = args.filter(
      (a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'),
    );
    ps.upsert({
      id,
      title: title.join(' '),
      criteria: flag('--criteria'),
      owner: flag('--owner'),
      dependsOn: listFlag('--depends'),
    });
    return say(`✓ ${id} saved`);
  }
  if (sub === 'set') {
    const [id, status] = args;
    if (!STATUSES.includes(status as Status))
      throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    ps.setStatus(id, status as Status, {
      evidence: flag('--evidence'),
      files: listFlag('--files'),
      tests: listFlag('--tests'),
      by: flag('--by') ?? 'cli',
    });
    return say(`✓ ${id} → ${status}`);
  }
  if (sub === 'current') {
    ps.setCurrent({ item: flag('--item'), next: flag('--next'), note: flag('--note') });
    return say('✓ current state updated');
  }
  if (sub === 'decide') {
    ps.decide(args[0], flag('--decision') ?? '', flag('--why') ?? '');
    return say('✓ decision recorded');
  }
  if (sub === 'block') {
    ps.block(args[0], flag('--item'));
    return say('✓ blocker recorded');
  }
  if (sub === 'resolve') {
    ps.resolve(args[0]);
    return say(`✓ ${args[0]} resolved`);
  }
  if (sub === 'checkpoint') {
    const { gitFacts } = await import('@agentbelt/core');
    ps.checkpoint(args[0] ?? 'checkpoint', gitFacts(ps.root).head?.split(' ')[0]);
    return say('✓ checkpoint saved (HANDOFF.md refreshed)');
  }
  throw new Error(
    'usage: agentbelt progress init|list|add|set|current|decide|block|resolve|checkpoint',
  );
}

async function contextCommand(): Promise<void> {
  const sub = args.shift() ?? 'show';
  const root = projectRoot(flag('--workspace') ?? process.cwd());
  if (sub === 'show') return out(JSON.stringify(contextView(readContext(root)), null, 2));
  if (sub === 'record') {
    const n = (k: string) => (flag(k) === undefined ? null : Number(flag(k)));
    const v = recordContext(root, {
      client: flag('--client') ?? 'unknown',
      model: flag('--model') ?? null,
      limit: n('--limit'),
      used: n('--used'),
      source: flag('--source') ?? 'reported by the client',
    });
    if (v.warning)
      say(
        `⚠ context ${v.remainingPercent} left: state saved, handoff refreshed. Compact or start a new session, then run: agentbelt resume`,
      );
    return out(JSON.stringify(v, null, 2));
  }
  if (sub === 'statusline') {
    // For Claude Code's statusLine command: reads its JSON from stdin, records it, prints one line.
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(input || '{}');
    } catch {
      // Not JSON: usage stays UNKNOWN.
    }
    const v = recordContext(root, fromClaudeStatusline(parsed));
    return out(
      v.remainingPercent === 'UNKNOWN'
        ? 'agentbelt · context: UNKNOWN'
        : `agentbelt · context ${v.remainingPercent} left${v.warning ? ' ⚠ save & compact' : ''}`,
    );
  }
  throw new Error(
    'usage: agentbelt context show | record --client C --model M --limit N --used N --source S | statusline',
  );
}

async function modelsCommand(): Promise<void> {
  const sub = args.shift() ?? 'list';
  const root = projectRoot(flag('--workspace') ?? process.cwd());
  if (sub === 'discover' || (sub === 'list' && !loadRegistry(root))) {
    say('• Discovering local models (read-only: ollama list/ps/show, LM Studio /v1/models)…');
    saveRegistry(root, await discoverModels());
  }
  if (sub === 'discover' || sub === 'list') {
    const reg = loadRegistry(root)!;
    out(
      `Ollama: ${reg.providers.ollama}   LM Studio: ${reg.providers.lmstudio}   memory: ${reg.memoryGB} GB`,
    );
    for (const m of reg.models)
      out(
        `${m.name.padEnd(34)} ${m.running ? 'running ' : 'idle    '} ctx ${String(m.configuredContext ?? '-').padStart(6)} / max ${String(m.maxContext ?? '?').padStart(6)}  ${m.capabilities.join(',').padEnd(26)} ${m.sizeGB ?? '?'} GB${m.fitsInMemory === false ? '  (too large for this machine)' : ''}`,
      );
    return;
  }
  if (sub === 'route') {
    const r = route(args[0] as TaskKind, loadRegistry(root), {
      allowLocalForComplex: has('--allow-local'),
    });
    return out(JSON.stringify(r, null, 2));
  }
  throw new Error(
    'usage: agentbelt models list | discover | route <deterministic|code-analysis|test-summary|documentation|architecture|high-risk-change>',
  );
}

const HELP = `agentbelt ${VERSION} — safe git, testing and workflow tools for any MCP client

  setup [--yes] [--clients deepseek,claude-code,codex,cursor,vscode,claude-desktop,lm-studio] [--from <dir-with-.tgz>]
        [--workspace <dir>]   (needed for DeepSeek Harness, Claude Desktop, LM Studio)
                     install a verified copy and connect your AI apps
  doctor             check the install and make real tool calls through it
  update [--to <version>] [--from <dir>]
                     install, verify, then switch atomically (old version kept)
  rollback           switch back to the previous version
  uninstall [--yes]  remove agentbelt from your AI apps (config backups are kept)
  agent setup [--provider local|deepseek|custom] [--model <m>] [--base-url <url>] [--allow-remote] [--key]
  agent status | remove   optional coding agent (agent_run tool); API keys go to the OS keychain
  schedule add <workflow> --cron "<m h dom mon dow>" | --at <ISO time>
  trigger add <workflow> --on file --paths "src/**,*.json" | --on git [--branch main] [--cooldown <sec>]
  schedule|trigger list | remove <id> | enable <id> | disable <id>
  scheduler run [--once] [--interval <sec>]
                     opt-in: runs due schedules/triggers while this command runs (Ctrl-C stops)
  serve [--workspace <dir>]   the MCP server (what your apps run)
  plugin list | add <npm-package|file.tgz> | remove <name>
                     third-party plugins: install scripts disabled, run only in an OS sandbox

  runs | show <run>  workflow runs in this project
  approve <run> <step> [--note "…"] | reject <run> <step>
                     decide an approval gate (only possible here, never via AI tools)
  audit [--n 20]     recent audit log entries for this project

  status             project status: milestones, current/next task, context, local models
  resume             agent-ready handoff with live git facts (read-only)
  progress init|list|add|set|current|decide|block|resolve|checkpoint
                     persistent progress (VERIFIED needs --evidence)
  context show|record|statusline
                     context-window usage as reported by the client (else UNKNOWN)
  models list|discover|route <kind>
                     local models (read-only discovery) and task routing
`;

async function main() {
  // `agentbelt <command> --help` prints help and never runs the command (setup, update and
  // uninstall change things).
  if (has('--help') || has('-h')) return out(HELP);
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
      // The coding agent is optional: offered only after `agentbelt agent setup`.
      let agent: ReturnType<typeof loadAgent> = null;
      try {
        agent = loadAgent();
      } catch (error) {
        notices.push(`agent not loaded: ${(error as Error).message}`);
      }
      return serveStdio({
        version: VERSION,
        plugins: [...FIRST_PARTY, ...(agent ? [agent.plugin] : []), ...external],
        model: agent?.model ?? null,
        workspace: flag('--workspace') ?? process.env.AGENTBELT_WORKSPACE,
        skillsDirs: [skillsDir()],
        notices,
      });
    }
    case 'plugin':
      return pluginCommand();
    case 'status':
      return out(statusReport(projectRoot(flag('--workspace') ?? process.cwd()), VERSION));
    case 'resume':
      return out(resumeReport(projectRoot(flag('--workspace') ?? process.cwd())));
    case 'progress':
      return progressCommand();
    case 'context':
      return contextCommand();
    case 'models':
      return modelsCommand();
    case 'agent':
      return agentCommand(args, { flag, has, say, confirm });
    case 'schedule':
    case 'trigger':
    case 'scheduler':
      return scheduleCommand(
        command,
        args,
        projectRoot(flag('--workspace') ?? process.cwd()),
        VERSION,
        { flag, has, say, out },
      );
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
        `Update ${activeVersion() ?? '(none)'} → ${to ?? 'local packages'}. Release notes: https://github.com/LovaRK/agentbelt/releases`,
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
