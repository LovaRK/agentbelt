// Persistent project state: the master plan's progress, decisions, blockers, checkpoints and a
// handoff, so any agent (Claude Code, Codex, DeepSeek Harness, a local model) can resume.
//
// Source of truth: <project>/.agentbelt/project.json (schema-versioned). The Markdown files
// (PROGRESS, CURRENT_STATE, DECISIONS, BLOCKERS, HANDOFF) are rendered from it on every change;
// MASTER_PLAN.md is written once from a template and then only edited by people.
// Writes take a lock file, write a temp file and rename it (atomic), and keep the previous good
// copy as project.json.bak, which is used if the main file is ever unreadable.
// Rules: VERIFIED needs evidence. Nothing here stores credentials; text is redacted and home paths
// are shortened to ~.
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from './redact.js';

export const STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'BLOCKED',
  'IMPLEMENTED_UNVERIFIED',
  'VERIFIED',
  'FAILED',
] as const;
export type Status = (typeof STATUSES)[number];

export interface Evidence {
  at: string;
  text: string;
  /** Who recorded it: a CLI user, or the client name for MCP calls. */
  by: string;
}

export interface Item {
  /** M10 for a milestone, M10.1 for a task under it. */
  id: string;
  title: string;
  status: Status;
  owner?: string;
  criteria?: string;
  dependsOn?: string[];
  evidence: Evidence[];
  files?: string[];
  tests?: string[];
  updatedAt: string;
}

export interface ProjectData {
  schemaVersion: 1;
  project: string;
  version?: string;
  items: Item[];
  decisions: { id: string; date: string; title: string; decision: string; why?: string }[];
  blockers: { id: string; date: string; text: string; item?: string; resolvedAt?: string }[];
  current: { item?: string; next?: string; note?: string };
  checkpoints: { at: string; note: string; commit?: string }[];
  updatedAt: string;
}

const ID = /^M\d{1,3}(\.\d{1,3})?$/;
const now = () => new Date().toISOString();

/** Redacts secrets and shortens the home directory, for anything written to state files. */
export function clean(text: string): string {
  const home = homedir();
  return redact(String(text)).split(home).join('~').slice(0, 2000);
}

export class ProjectState {
  readonly dir: string;
  readonly file: string;
  constructor(
    readonly root: string,
    private readonly name = 'project',
  ) {
    this.dir = join(root, '.agentbelt');
    this.file = join(this.dir, 'project.json');
  }

  exists(): boolean {
    return existsSync(this.file) || existsSync(`${this.file}.bak`);
  }

  load(): ProjectData {
    for (const f of [this.file, `${this.file}.bak`]) {
      try {
        const data = JSON.parse(readFileSync(f, 'utf8')) as ProjectData;
        if (data.schemaVersion !== 1)
          throw new Error(`unsupported state schema ${data.schemaVersion}`);
        return data;
      } catch (error) {
        if ((error as Error).message.startsWith('unsupported')) throw error;
        // Unreadable (e.g. interrupted write): try the backup.
      }
    }
    return {
      schemaVersion: 1,
      project: this.name,
      items: [],
      decisions: [],
      blockers: [],
      current: {},
      checkpoints: [],
      updatedAt: now(),
    };
  }

  /** Runs `change` under the lock and saves atomically; returns the saved state. */
  update(event: string, change: (s: ProjectData) => void, by = 'cli'): ProjectData {
    mkdirSync(this.dir, { recursive: true });
    return this.withLock(() => {
      const state = this.load();
      change(state);
      state.updatedAt = now();
      const text = `${JSON.stringify(state, null, 2)}\n`;
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      if (existsSync(this.file)) {
        try {
          JSON.parse(readFileSync(this.file, 'utf8'));
          writeFileSync(`${this.file}.bak`, readFileSync(this.file));
        } catch {
          // Don't replace a good backup with a broken main file.
        }
      }
      renameSync(tmp, this.file);
      this.history({ event, by: clean(by) });
      this.render(state);
      return state;
    });
  }

  private withLock<T>(fn: () => T): T {
    const lock = join(this.dir, 'project.lock');
    const token = `${process.pid} ${now()} ${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const fd = openSync(lock, 'wx');
        writeFileSync(fd, token);
        closeSync(fd);
        break;
      } catch {
        // Held by someone else. Take it over only if the holder is dead or it is very old, and
        // only if it is still the same lock we judged stale (rename is atomic; a lock that
        // changed in between is put back).
        let seen = '';
        let stale = false;
        try {
          seen = readFileSync(lock, 'utf8');
          stale =
            Date.now() - statSync(lock).mtimeMs > 60_000 || !alive(Number(seen.split(' ')[0]));
        } catch {
          continue; // vanished: retry at once
        }
        if (stale) {
          const moved = `${lock}.${process.pid}.stale`;
          try {
            renameSync(lock, moved);
            if (readFileSync(moved, 'utf8') === seen) rmSync(moved, { force: true });
            else {
              try {
                linkSync(moved, lock); // restore a lock that wasn't stale (fails if a new one exists)
              } catch {
                // A newer lock is already in place; leave it.
              }
              rmSync(moved, { force: true });
            }
          } catch {
            // Someone else handled it.
          }
          continue;
        }
        if (Date.now() > deadline) throw new Error('project state is locked by another process');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      // Release only our own lock.
      try {
        if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  history(entry: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(
      join(this.dir, 'execution-history.jsonl'),
      `${JSON.stringify({ at: now(), ...entry })}\n`,
    );
  }

  // ---- changes -------------------------------------------------------------------------------

  upsert(item: Partial<Item> & { id: string; title?: string }, by = 'cli'): ProjectData {
    if (!ID.test(item.id)) throw new Error(`invalid id ${item.id} (use M10 or M10.1)`);
    return this.update(
      `upsert ${item.id}`,
      (s) => {
        const existing = s.items.find((i) => i.id === item.id);
        if (existing) {
          if (item.title) existing.title = clean(item.title);
          if (item.owner !== undefined) existing.owner = clean(item.owner);
          if (item.criteria !== undefined) existing.criteria = clean(item.criteria);
          if (item.dependsOn) existing.dependsOn = item.dependsOn;
          existing.updatedAt = now();
        } else {
          if (!item.title) throw new Error(`new item ${item.id} needs a title`);
          s.items.push({
            id: item.id,
            title: clean(item.title),
            status: 'NOT_STARTED',
            owner: item.owner && clean(item.owner),
            criteria: item.criteria && clean(item.criteria),
            dependsOn: item.dependsOn,
            evidence: [],
            updatedAt: now(),
          });
          s.items.sort((a, b) => order(a.id) - order(b.id));
        }
      },
      by,
    );
  }

  /**
   * Changes an item's status. VERIFIED requires evidence (given now or already recorded).
   * files/tests are the actual files changed and tests run for this step.
   */
  setStatus(
    id: string,
    status: Status,
    opts: { evidence?: string; files?: string[]; tests?: string[]; by?: string } = {},
  ): ProjectData {
    if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
    const by = opts.by ?? 'cli';
    return this.update(
      `status ${id} → ${status}`,
      (s) => {
        const item = s.items.find((i) => i.id === id);
        if (!item) throw new Error(`no item ${id}`);
        if (opts.evidence)
          item.evidence.push({ at: now(), text: clean(opts.evidence), by: clean(by) });
        if (status === 'VERIFIED' && !opts.evidence)
          throw new Error(
            `${id} can't be VERIFIED without evidence for this change (--evidence "…")`,
          );
        if (opts.files?.length)
          item.files = [...new Set([...(item.files ?? []), ...opts.files.map(clean)])];
        if (opts.tests?.length) item.tests = [...(item.tests ?? []), ...opts.tests.map(clean)];
        item.status = status;
        item.updatedAt = now();
        if (status === 'IN_PROGRESS') s.current.item = id;
        if (s.current.item === id && ['VERIFIED', 'IMPLEMENTED_UNVERIFIED'].includes(status))
          s.current.next = nextActionable(s)?.id;
      },
      by,
    );
  }

  setCurrent(current: { item?: string; next?: string; note?: string }, by = 'cli'): ProjectData {
    return this.update(
      'current',
      (s) => {
        s.current = {
          ...s.current,
          ...Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v && clean(v)])),
        };
      },
      by,
    );
  }

  decide(title: string, decision: string, why = '', by = 'cli'): ProjectData {
    return this.update(
      `decision ${title}`,
      (s) => {
        s.decisions.push({
          id: `D${s.decisions.length + 1}`,
          date: now().slice(0, 10),
          title: clean(title),
          decision: clean(decision),
          why: clean(why),
        });
      },
      by,
    );
  }

  block(text: string, item?: string, by = 'cli'): ProjectData {
    return this.update(
      `blocker`,
      (s) => {
        s.blockers.push({
          id: `B${s.blockers.length + 1}`,
          date: now().slice(0, 10),
          text: clean(text),
          item,
        });
      },
      by,
    );
  }

  resolve(id: string, by = 'cli'): ProjectData {
    return this.update(
      `resolve ${id}`,
      (s) => {
        const b = s.blockers.find((x) => x.id === id);
        if (!b) throw new Error(`no blocker ${id}`);
        b.resolvedAt = now();
      },
      by,
    );
  }

  checkpoint(note: string, commit?: string, by = 'cli'): ProjectData {
    return this.update(
      `checkpoint`,
      (s) => {
        s.checkpoints.push({ at: now(), note: clean(note), commit });
        s.checkpoints = s.checkpoints.slice(-50);
      },
      by,
    );
  }

  // ---- views ---------------------------------------------------------------------------------

  summary(s = this.load()) {
    const milestones = s.items.filter((i) => !i.id.includes('.'));
    const count = (st: Status) => milestones.filter((i) => i.status === st).length;
    return {
      total: milestones.length,
      verified: count('VERIFIED'),
      inProgress: count('IN_PROGRESS'),
      unverified: count('IMPLEMENTED_UNVERIFIED'),
      pending: count('NOT_STARTED'),
      blocked: count('BLOCKED'),
      failed: count('FAILED'),
      /** Share of milestones VERIFIED: evidence-based, not effort-based. */
      completion: milestones.length ? Math.round((count('VERIFIED') / milestones.length) * 100) : 0,
    };
  }

  /** Writes the human-readable files. MASTER_PLAN.md is created once and never overwritten. */
  render(s = this.load()): void {
    const w = (name: string, text: string) => {
      const f = join(this.dir, name);
      writeFileSync(`${f}.${process.pid}.tmp`, text);
      renameSync(`${f}.${process.pid}.tmp`, f);
    };
    const plan = join(this.dir, 'MASTER_PLAN.md');
    if (!existsSync(plan))
      w(
        'MASTER_PLAN.md',
        `# ${s.project} — master plan\n\nThe single source of truth for scope and milestones. Edit this file by hand; agentbelt never\noverwrites it. Progress is tracked in PROGRESS.md (generated from project.json).\n\n## Scope\n\n## Milestones\n\n${s.items
          .filter((i) => !i.id.includes('.'))
          .map((i) => `- ${i.id}: ${i.title}${i.criteria ? ` — done when: ${i.criteria}` : ''}`)
          .join('\n')}\n`,
      );
    const sum = this.summary(s);
    w(
      'PROGRESS.md',
      `# Progress (generated — edit with \`agentbelt progress\`)\n\nVerified ${sum.verified}/${sum.total} milestones (${sum.completion}% by evidence). Updated ${s.updatedAt}.\n\n| ID | Title | Status | Owner | Depends on | Latest evidence |\n| --- | --- | --- | --- | --- | --- |\n${s.items
        .map(
          (i) =>
            `| ${i.id} | ${i.title} | ${i.status} | ${i.owner ?? ''} | ${(i.dependsOn ?? []).join(', ')} | ${(i.evidence.at(-1)?.text ?? '').replace(/\|/g, '/').slice(0, 160)} |`,
        )
        .join('\n')}\n\n## Details\n\n${s.items
        .filter((i) => i.criteria || i.evidence.length || i.files?.length || i.tests?.length)
        .map(
          (i) =>
            `### ${i.id} ${i.title} — ${i.status}\n${i.criteria ? `- Done when: ${i.criteria}\n` : ''}${i.files?.length ? `- Files: ${i.files.join(', ')}\n` : ''}${i.tests?.length ? `- Tests: ${i.tests.slice(-5).join('; ')}\n` : ''}${i.evidence.map((e) => `- ${e.at.slice(0, 16)} (${e.by}): ${e.text}`).join('\n')}`,
        )
        .join('\n\n')}\n`,
    );
    const cur = s.items.find((i) => i.id === s.current.item);
    const next = s.items.find((i) => i.id === s.current.next) ?? nextActionable(s);
    w(
      'CURRENT_STATE.md',
      `# Current state (generated)\n\n- Now: ${cur ? `${cur.id} ${cur.title} (${cur.status})` : 'nothing in progress'}\n- Next: ${next ? `${next.id} ${next.title}` : 'none'}\n${s.current.note ? `- Note: ${s.current.note}\n` : ''}- Last checkpoint: ${s.checkpoints.at(-1) ? `${s.checkpoints.at(-1)!.at} — ${s.checkpoints.at(-1)!.note}` : 'none'}\n`,
    );
    w(
      'DECISIONS.md',
      `# Decisions (generated)\n\n${s.decisions.map((d) => `## ${d.id} ${d.title} (${d.date})\n\n${d.decision}${d.why ? `\n\nWhy: ${d.why}` : ''}`).join('\n\n') || 'None recorded.'}\n`,
    );
    const open = s.blockers.filter((b) => !b.resolvedAt);
    w(
      'BLOCKERS.md',
      `# Blockers (generated)\n\n${open.map((b) => `- ${b.id} (${b.date})${b.item ? ` [${b.item}]` : ''}: ${b.text}`).join('\n') || 'No open blockers.'}\n`,
    );
    w('HANDOFF.md', this.handoff(s));
  }

  /** A compact, agent-ready handoff. `extra` adds live facts (git, models, context). */
  handoff(s = this.load(), extra: string[] = []): string {
    const sum = this.summary(s);
    const cur = s.items.find((i) => i.id === s.current.item);
    const next = s.items.find((i) => i.id === s.current.next) ?? nextActionable(s);
    const interrupted = s.items.filter((i) => i.status === 'IN_PROGRESS');
    const lastVerified = [...s.items]
      .filter((i) => i.status === 'VERIFIED')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return [
      `# Handoff — ${s.project}${s.version ? ` ${s.version}` : ''}`,
      '',
      'Read this first, then `.agentbelt/MASTER_PLAN.md`. Run `agentbelt resume` for live git/model facts.',
      'Update progress with `agentbelt progress set <id> <STATUS> --evidence "…"` (VERIFIED needs evidence).',
      '',
      `- Milestones: ${sum.verified} verified, ${sum.unverified} implemented-unverified, ${sum.inProgress} in progress, ${sum.pending} not started, ${sum.blocked} blocked, ${sum.failed} failed`,
      `- Current: ${cur ? `${cur.id} ${cur.title} (${cur.status})` : 'none'}`,
      `- Interrupted (IN_PROGRESS): ${interrupted.map((i) => `${i.id} ${i.title}`).join('; ') || 'none'}`,
      `- Last verified: ${lastVerified ? `${lastVerified.id} ${lastVerified.title} — ${lastVerified.evidence.at(-1)?.text ?? ''}` : 'none'}`,
      `- Next: ${next ? `${next.id} ${next.title}${next.criteria ? ` (done when: ${next.criteria})` : ''}` : 'none'}`,
      `- Open blockers: ${
        s.blockers
          .filter((b) => !b.resolvedAt)
          .map((b) => `${b.id} ${b.text}`)
          .join('; ') || 'none'
      }`,
      `- Recent decisions: ${
        s.decisions
          .slice(-3)
          .map((d) => `${d.id} ${d.title}`)
          .join('; ') || 'none'
      }`,
      `- Last checkpoint: ${s.checkpoints.at(-1) ? `${s.checkpoints.at(-1)!.at} ${s.checkpoints.at(-1)!.note}` : 'none'}`,
      ...extra.map((e) => `- ${e}`),
      '',
    ].join('\n');
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function order(id: string): number {
  const [m, t] = id.slice(1).split('.').map(Number);
  return m * 1000 + (t ?? 0);
}

/** The first item that isn't done and whose dependencies are all VERIFIED. */
export function nextActionable(s: ProjectData): Item | undefined {
  const done = (id: string) => s.items.find((i) => i.id === id)?.status === 'VERIFIED';
  return s.items.find(
    (i) => !['VERIFIED', 'BLOCKED'].includes(i.status) && (i.dependsOn ?? []).every(done),
  );
}
