// Audit log: one JSON line per tool call, command and denial, in <workspace>/.agentbelt/audit.jsonl.
// Arguments and output are redacted and truncated. `isolation` says honestly how an action ran:
// "policy-only" means it passed the permission and command checks but ran without an OS sandbox.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.js';

export type Isolation = 'policy-only' | 'os-sandbox' | 'none';

export interface AuditEntry {
  ts: string;
  kind: 'tool' | 'exec' | 'file' | 'denied' | 'model';
  client?: string;
  plugin: string;
  tool?: string;
  detail: string;
  ok: boolean;
  isolation?: Isolation;
  ms?: number;
}

export class AuditLog {
  readonly file: string;
  constructor(
    workspace: string,
    private readonly client = () => 'unknown',
  ) {
    this.file = join(workspace, '.agentbelt', 'audit.jsonl');
  }

  write(entry: Omit<AuditEntry, 'ts' | 'client'>): void {
    const line: AuditEntry = {
      ts: new Date().toISOString(),
      client: this.client(),
      ...entry,
      detail: redact(entry.detail).slice(0, 1000),
    };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch {
      // A read-only workspace must not break the tool call; the call itself still reports.
    }
  }

  tail(n = 50): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => JSON.parse(l) as AuditEntry);
  }
}
