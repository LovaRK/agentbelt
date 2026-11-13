// `agentbelt agent setup | status | remove`: choose the model for the optional coding agent.
// The config file holds no secrets; an API key goes into the OS keychain, typed by the user at the
// keychain tool's own prompt (never on the command line, where other processes could see it).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import agentPlugin from '@agentbelt/plugin-agent';
import tokensPlugin from '@agentbelt/plugin-tokens';
import {
  checkModelConfig,
  createModelClient,
  isLoopback,
  KEYCHAIN_SERVICE,
  loadModelConfig,
  PRESETS,
  readSecret,
  type ModelClient,
  type ModelConfig,
  type Plugin,
} from '@agentbelt/core';
import { home } from './paths.js';

export const agentConfigFile = () => join(home(), 'agent-model.json');

/**
 * The agent plugin (with the tokens plugin, which reports on its runs) and its model, or null
 * when no agent is configured (the default).
 */
export function loadAgent(): { plugins: Plugin[]; model: ModelClient } | null {
  const config = loadModelConfig(agentConfigFile());
  return config
    ? { plugins: [agentPlugin, tokensPlugin as Plugin], model: createModelClient(config) }
    : null;
}

function storeKey(account: string): boolean {
  const r =
    process.platform === 'darwin'
      ? spawnSync(
          '/usr/bin/security',
          // -w last with no value: `security` prompts for the key itself.
          ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
          { stdio: 'inherit' },
        )
      : spawnSync(
          'secret-tool',
          ['store', '--label=agentbelt agent', 'service', KEYCHAIN_SERVICE, 'account', account],
          { stdio: 'inherit' },
        );
  return r.status === 0;
}

function deleteKey(account: string) {
  if (process.platform === 'darwin')
    spawnSync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
      {
        stdio: 'ignore',
      },
    );
  else
    spawnSync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account], {
      stdio: 'ignore',
    });
}

async function localModels(baseUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export async function agentCommand(
  args: string[],
  io: {
    flag(name: string): string | undefined;
    has(name: string): boolean;
    say(s?: string): void;
    confirm(q: string): Promise<boolean>;
  },
): Promise<void> {
  const sub = args.shift() ?? 'status';
  const file = agentConfigFile();
  if (sub === 'status') {
    const c = loadModelConfig(file);
    if (!c)
      return io.say('No agent model configured (optional). Set one up: agentbelt agent setup');
    const key = c.key
      ? readSecret(c.key.service, c.key.account)
        ? 'in keychain'
        : 'MISSING'
      : 'none needed';
    return io.say(
      `agent model: ${c.model}\nendpoint: ${c.baseUrl} (${c.provider}${c.allowRemote ? ', remote allowed' : ', this machine only'})\nAPI key: ${key}`,
    );
  }
  if (sub === 'remove') {
    const c = loadModelConfig(file);
    if (c?.key) deleteKey(c.key.account);
    rmSync(file, { force: true });
    return io.say('✓ agent model removed; the agent tool is no longer offered');
  }
  if (sub !== 'setup') throw new Error('usage: agentbelt agent setup | status | remove');

  const provider = (io.flag('--provider') ?? 'local') as ModelConfig['provider'];
  if (!(provider in PRESETS)) throw new Error('--provider must be local, deepseek or custom');
  const baseUrl = io.flag('--base-url') ?? PRESETS[provider].baseUrl;
  if (!baseUrl) throw new Error('--base-url is required for a custom endpoint');
  const remote = !isLoopback(new URL(baseUrl));
  let model = io.flag('--model') ?? PRESETS[provider].model;
  if (!model && !remote) {
    const found = await localModels(baseUrl);
    if (!found.length)
      throw new Error(`no models found at ${baseUrl}; is the server running? pass --model`);
    io.say(`Models at ${baseUrl}:\n  ${found.join('\n  ')}`);
    throw new Error('choose one with --model <name>');
  }
  const needsKey = provider === 'deepseek' || (provider === 'custom' && io.has('--key'));
  const account = new URL(baseUrl).host;
  const config: ModelConfig = {
    provider,
    baseUrl,
    model,
    ...(needsKey ? { key: { service: KEYCHAIN_SERVICE, account } } : {}),
    // Choosing the DeepSeek API, or passing --allow-remote, is the explicit opt-in to send
    // project content to a remote endpoint.
    ...(remote && (provider === 'deepseek' || io.has('--allow-remote'))
      ? { allowRemote: true }
      : {}),
  };
  const problem = checkModelConfig(config);
  if (problem) throw new Error(`${problem}${remote ? ' (pass --allow-remote to opt in)' : ''}`);

  io.say(`Agent model: ${model} at ${baseUrl}`);
  if (remote)
    io.say(
      '  ! Remote endpoint: files the agent reads are sent to this service. It only acts when an AI app calls agent_run.',
    );
  if (needsKey)
    io.say(`  The API key goes into the OS keychain (${KEYCHAIN_SERVICE} / ${account}).`);
  if (!(await io.confirm('Save this agent model?'))) return io.say('nothing changed');
  if (needsKey && !readSecret(KEYCHAIN_SERVICE, account)) {
    io.say('Enter the API key at the keychain prompt:');
    if (!storeKey(account)) throw new Error('the key was not stored; nothing changed');
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  io.say(`✓ saved ${file}. Restart your AI app's agentbelt server to offer the agent_run tool.`);
  if (!existsSync(file)) throw new Error('config was not written');
}
