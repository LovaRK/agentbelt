// A minimal stdio MCP client, used by `doctor` and update verification to start a server exactly
// the way a client app would and make real tool calls.
import { spawn, type ChildProcess } from 'node:child_process';

export class StdioClient {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  stderr = '';

  constructor(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          } else if (msg.id !== undefined && msg.method === 'roots/list') {
            // Answer roots requests with no roots, like a client without a workspace.
            this.child.stdin!.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots: [] } })}\n`,
            );
          }
        } catch {
          // Ignore non-JSON output.
        }
      }
    });
    this.child.stderr!.on('data', (c: Buffer) => (this.stderr += c.toString()).slice(-4000));
  }

  request(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out after ${timeoutMs} ms${this.stderr ? `\n${this.stderr.trim()}` : ''}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      this.child.once('exit', (code) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(
            `server exited (${code}) during ${method}${this.stderr ? `:\n${this.stderr.trim()}` : ''}`,
          ),
        );
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(clientName = 'agentbelt-doctor') {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    });
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    return r;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args });
    return {
      text: (r.content ?? []).map((c: any) => c.text ?? '').join('\n'),
      isError: !!r.isError,
    };
  }

  close() {
    this.child.stdin!.end();
    this.child.kill();
  }
}
