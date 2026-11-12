// The project status report and resume handoff, shared by `agentbelt status|resume` and the
// project_get_status / project_get_handoff MCP tools. Git is only read (branch, changed files).
import { execFileSync } from 'node:child_process';
import { contextView, readContext, WARN_AT } from './context.js';
import { loadRegistry } from './models.js';
import { nextActionable, ProjectState } from './project-state.js';

export function gitFacts(root: string) {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const status = git('status', '--porcelain');
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    head: git('log', '-1', '--format=%h %s'),
    changed: status === null ? null : status.split('\n').filter(Boolean),
  };
}

export function statusReport(root: string, version: string): string {
  const ps = new ProjectState(root);
  if (!ps.exists())
    return `No project state in ${root}/.agentbelt yet. Start with: agentbelt progress init`;
  const s = ps.load();
  const sum = ps.summary(s);
  const cur = s.items.find((i) => i.id === s.current.item);
  const next = s.items.find((i) => i.id === s.current.next) ?? nextActionable(s);
  const lastVerified = [...s.items]
    .filter((i) => i.status === 'VERIFIED')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const ctx = contextView(readContext(root));
  const reg = loadRegistry(root);
  return [
    'AGENTBELT PROJECT STATUS',
    `Project: ${s.project}`,
    `Version: ${s.version ?? version}`,
    'Milestones:',
    `  Verified: ${sum.verified}/${sum.total} (${sum.completion}% by evidence)`,
    `  Implemented, unverified: ${sum.unverified}`,
    `  In progress: ${sum.inProgress}`,
    `  Not started: ${sum.pending}`,
    `  Blocked: ${sum.blocked}`,
    `  Failed: ${sum.failed}`,
    'Current milestone:',
    `  ${cur ? `${cur.id} — ${cur.title} (${cur.status})` : 'none in progress'}`,
    'Last verified:',
    `  ${lastVerified ? `${lastVerified.id} — ${lastVerified.title}` : 'none'}`,
    'Next:',
    `  ${next ? `${next.id} — ${next.title}` : 'nothing actionable'}`,
    'Context:',
    `  ${ctx.limit === 'UNKNOWN' || ctx.used === 'UNKNOWN' ? `UNKNOWN (${ctx.source})` : `${ctx.client} ${ctx.model}: ${ctx.used}/${ctx.limit} tokens, ${ctx.remainingPercent} left${ctx.warning ? ` — WARNING: over ${WARN_AT * 100}% used; save state and compact or start a new session` : ''} (reported ${ctx.at})`}`,
    'Local models:',
    ...(reg
      ? [
          `  ${reg.models.length ? reg.models.map((m) => `${m.name}${m.running ? ' (running)' : ''}`).join(', ') : 'none found'} — discovered ${reg.discoveredAt.slice(0, 16)}`,
        ]
      : ['  not discovered yet (agentbelt models discover)']),
    'Open blockers:',
    `  ${
      s.blockers
        .filter((b) => !b.resolvedAt)
        .map((b) => `${b.id} ${b.text}`)
        .join('\n  ') || 'none'
    }`,
    'Last checkpoint:',
    `  ${s.checkpoints.at(-1) ? `${s.checkpoints.at(-1)!.at} — ${s.checkpoints.at(-1)!.note}` : 'none'}`,
    'Resume:',
    '  agentbelt resume',
  ].join('\n');
}

/** Live facts plus the persisted handoff; writes the refreshed HANDOFF.md. Never changes code. */
export function resumeReport(root: string): string {
  const ps = new ProjectState(root);
  if (!ps.exists())
    return `No project state in ${root}/.agentbelt yet. Start with: agentbelt progress init`;
  const s = ps.load();
  const g = gitFacts(root);
  const ctx = contextView(readContext(root));
  const reg = loadRegistry(root);
  const extra = [
    `Git: branch ${g.branch ?? 'unknown'}, HEAD ${g.head ?? 'unknown'}, ${g.changed === null ? 'not a git repo' : g.changed.length ? `${g.changed.length} uncommitted change(s): ${g.changed.slice(0, 8).join(', ')}` : 'clean working tree'}`,
    `Context: ${ctx.used === 'UNKNOWN' ? 'UNKNOWN' : `${ctx.remainingPercent} left in ${ctx.client}`}`,
    `Local models: ${
      reg
        ? reg.models
            .filter((m) => m.fitsInMemory !== false)
            .map((m) => m.name)
            .join(', ') || 'none'
        : 'not discovered'
    }`,
  ];
  const text = ps.handoff(s, extra);
  ps.history({ event: 'resume', by: 'cli' });
  return text;
}
