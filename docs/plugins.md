# Writing a plugin

A plugin is a name, the permissions it needs, and a list of tools. Tools never touch the system
directly: they get a context (`ctx`) whose every action is checked against the plugin's
permissions when it happens.

## Built-in style (TypeScript, in this repo)

```ts
import { definePlugin, ok } from '@agentbelt/core';
import * as z from 'zod';

export default definePlugin({
  name: 'todo',
  version: '0.1.0',
  description: 'Finds TODO comments',
  permissions: { exec: ['git'], read: true },
  tools: [
    {
      name: 'list',
      description: 'Lists TODO comments in tracked files.',
      input: z.object({ limit: z.number().int().max(200).default(50) }),
      readOnly: true,
      async run({ limit }, ctx) {
        const r = await ctx.exec('git', ['grep', '-n', 'TODO']);
        return ok(r.stdout.split('\n').slice(0, limit).join('\n'));
      },
    },
  ],
});
```

Clients see the tool as `todo_list`.

## Context

| Call                                          | Needs             | Notes                                                    |
| --------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `ctx.exec(program, args, { cwd, timeoutMs })` | `exec: [program]` | Also passes the core command policy; output is redacted  |
| `ctx.readFile(path)` / `ctx.listFiles(dir)`   | `read: true`      | Inside the project only; never `.git` or agentbelt state |
| `ctx.writeFile(path, text)`                   | `write: true`     | Atomic write inside the project                          |
| `ctx.callTool(id, args)`                      | `callTools: true` | The called tool runs with its own plugin's permissions   |
| `ctx.state.get/set/list`                      | none              | Small JSON documents private to the plugin               |

## Third-party plugins (published to npm)

Third-party plugins run in an OS sandbox in a separate process, so they are plain JavaScript and
describe inputs with JSON Schema. Declare the plugin statically in `package.json`. agentbelt reads
this before any code runs, and the user approves these permissions:

```json
{
  "name": "agentbelt-plugin-todo",
  "version": "1.0.0",
  "type": "module",
  "agentbelt": {
    "name": "todo",
    "plugin": "index.js",
    "permissions": { "exec": ["git"], "read": true }
  }
}
```

```js
// index.js: every ctx call is asynchronous here (it crosses the sandbox boundary)
export default {
  name: 'todo',
  version: '1.0.0',
  tools: [
    {
      name: 'list',
      description: 'Lists TODO comments.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      async run(_args, ctx) {
        const r = await ctx.exec('git', ['grep', '-n', 'TODO']);
        return { text: r.stdout };
      },
    },
  ],
};
```

Rules for third-party plugins:

- No install scripts: they are never run.
- No network.
- No access to files outside the plugin's own folder except through `ctx`.
