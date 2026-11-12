// Runs ONE untrusted plugin inside the OS sandbox (see sandbox.ts). It has no imports except
// Node built-ins, so it works from the sandbox's narrow read allowance. Protocol: JSON lines.
//   host → parent  {t:'manifest', name, version, tools:[{name, description, inputSchema}]}
//   parent → host  {t:'call', id, tool, args}
//   host → parent  {t:'ctx', id, call, op, params} the plugin asks the broker to act for call
//   parent → host  {t:'ctx-result', id, value} | {t:'ctx-result', id, error}
//   host → parent  {t:'result', id, result}       | {t:'result', id, error}
// The plugin's context is entirely remote: every action is checked and audited by the parent.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

type Msg = Record<string, any>;
const send = (m: Msg) => process.stdout.write(`${JSON.stringify(m)}\n`);
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 1;

function remote(call: number, op: string, params: unknown): Promise<any> {
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'ctx', id, call, op, params });
  });
}

// Everything the plugin can do goes through the parent, tagged with the call it belongs to.
const makeCtx = (call: number) => {
  const r = (op: string, params: unknown) => remote(call, op, params);
  return {
    exec: (program: string, args: string[], options?: unknown) =>
      r('exec', { program, args, options }),
    readFile: (path: string) => r('readFile', { path }),
    writeFile: (path: string, text: string) => r('writeFile', { path, text }),
    listFiles: (dir: string) => r('listFiles', { dir }),
    callTool: (name: string, args: unknown) => r('callTool', { name, args }),
    listTools: () => r('listTools', {}),
    state: {
      get: (key: string) => r('state.get', { key }),
      set: (key: string, value: unknown) => r('state.set', { key, value }),
      list: () => r('state.list', {}),
    },
  };
};

const entry = process.argv[2];
const mod = await import(pathToFileURL(entry).href);
const plugin = mod.default ?? mod;
const tools = new Map<string, any>((plugin.tools ?? []).map((t: any) => [t.name, t]));
send({
  t: 'manifest',
  name: plugin.name,
  version: plugin.version,
  description: plugin.description ?? '',
  tools: [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object' },
    readOnly: !!t.readOnly,
  })),
});

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m: Msg;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.t === 'ctx-result') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.value);
  } else if (m.t === 'call') {
    const tool = tools.get(m.tool);
    try {
      if (!tool) throw new Error(`no tool ${m.tool}`);
      const result = await tool.run(m.args ?? {}, makeCtx(m.id));
      send({ t: 'result', id: m.id, result });
    } catch (error) {
      send({ t: 'result', id: m.id, error: (error as Error).message });
    }
  }
});
