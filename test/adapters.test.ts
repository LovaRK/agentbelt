// Fixture tests for the JSON-config client adapters: Cursor, VS Code, Claude Desktop, LM Studio.
// They only touch a temporary home folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appSupport,
  claudeDesktop,
  cursor,
  lmStudio,
  vscode,
  type ClientAdapter,
} from '../packages/cli/src/adapters.ts';

let home = '';
before(() => (home = mkdtempSync(join(tmpdir(), 'agentbelt-adapters-'))));
after(() => rmSync(home, { recursive: true, force: true }));

const entry = { command: '/x/bin/agentbelt', args: ['serve'] };
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

const cases: [string, () => ClientAdapter, () => string, string, Record<string, unknown>][] = [
  [
    'Cursor',
    () => cursor(home),
    () => join(home, '.cursor'),
    'mcpServers',
    { command: '/x/bin/agentbelt', args: ['serve'] },
  ],
  [
    'VS Code',
    () => vscode(home),
    () => join(appSupport(home), 'Code', 'User'),
    'servers',
    { type: 'stdio', command: '/x/bin/agentbelt', args: ['serve'] },
  ],
  [
    'Claude Desktop',
    () => claudeDesktop(home),
    () => join(appSupport(home), 'Claude'),
    'mcpServers',
    { command: '/x/bin/agentbelt', args: ['serve'] },
  ],
  [
    'LM Studio',
    () => lmStudio(home),
    () => join(home, '.lmstudio'),
    'mcpServers',
    { command: '/x/bin/agentbelt', args: ['serve'] },
  ],
];

for (const [label, make, dir, key, expected] of cases) {
  test(`${label}: detect, add next to other servers, idempotent, exact removal`, () => {
    const a = make();
    assert.equal(a.label, label);
    if (label !== 'Cursor') assert.equal(a.detect(), false); // Cursor also checks /Applications
    mkdirSync(dir(), { recursive: true });
    assert.equal(a.detect(), true);
    const file = a.configFile()!;
    assert.ok(file.startsWith(dir()));
    const original = { theme: 'dark', [key]: { other: { command: 'other-server' } } };
    writeFileSync(file, JSON.stringify(original, null, 2) + '\n');
    assert.equal(a.isInstalled(), false);

    a.add(entry);
    a.add(entry); // again: replaced, not duplicated
    const after = json(file);
    assert.deepEqual(after[key].agentbelt, expected);
    assert.deepEqual(after[key].other, { command: 'other-server' }); // the user's entries are kept
    assert.equal(after.theme, 'dark');
    assert.equal(a.isInstalled(), true);
    assert.match(a.describe(entry), new RegExp(`${key}\\.agentbelt`));

    a.remove();
    assert.deepEqual(json(file), original);
    assert.equal(a.isInstalled(), false);
  });
}

test('a missing config file is created; a file with comments is never rewritten', () => {
  const a = lmStudio(home);
  rmSync(join(home, '.lmstudio'), { recursive: true, force: true });
  mkdirSync(join(home, '.lmstudio'));
  a.add(entry);
  assert.deepEqual(json(a.configFile()!), { mcpServers: { agentbelt: entry } });

  const v = vscode(home);
  mkdirSync(join(appSupport(home), 'Code', 'User'), { recursive: true });
  const jsonc = '{\n  // my servers\n  "servers": {}\n}\n';
  writeFileSync(v.configFile()!, jsonc);
  assert.throws(() => v.add(entry), /not plain JSON.*not changed/);
  assert.equal(readFileSync(v.configFile()!, 'utf8'), jsonc);
  assert.equal(v.isInstalled(), false);
});

test('apps that give servers no project require --workspace; the others do not', () => {
  assert.equal(claudeDesktop(home).needsWorkspace, true);
  assert.equal(lmStudio(home).needsWorkspace, true);
  assert.ok(!vscode(home).needsWorkspace); // VS Code sends workspace folders as MCP roots
  assert.ok(!cursor(home).needsWorkspace); // Cursor sends the open folder as MCP roots
  // An explicit --workspace is kept as is for Cursor.
  const c = cursor(home);
  mkdirSync(join(home, '.cursor'), { recursive: true });
  c.add({ command: 'a', args: ['serve', '--workspace', '/p'] });
  assert.deepEqual(json(c.configFile()!).mcpServers.agentbelt.args, ['serve', '--workspace', '/p']);
});
