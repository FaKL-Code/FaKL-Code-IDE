import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter, AgentHandle, StartOptions } from '@fakl/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  ClaudeAccounts,
  EventBus,
  parseAuthStatus,
  Router,
  type ClaudeRunner,
} from '../src/index.js';

const SECRET = 'sk-ant-oat01-SEGREDO-QUE-NAO-PODE-APARECER';
const call = { connectionId: 'c', notify: () => undefined, onClose: () => undefined };

describe('contas do Claude', () => {
  let home: string;
  let logs: string[];
  const runs: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  // O falso devolve também um token no stdout: nada disso pode escapar.
  const runClaude: ClaudeRunner = (args, env) => {
    runs.push({ args, env });
    const slot = env.CLAUDE_CONFIG_DIR?.endsWith(join('claude', '1')) ?? false;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify(
        slot
          ? {
              loggedIn: true,
              email: 'a@b.dev',
              subscriptionType: 'max',
              accessToken: SECRET,
            }
          : { loggedIn: false },
      ),
    });
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-accounts-'));
    logs = [];
    runs.length = 0;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function make(file = join(home, 'data', 'claude-accounts.json')): ClaudeAccounts {
    return new ClaudeAccounts({ home, file, runClaude, log: (m) => logs.push(m) });
  }

  it('cria as pastas isoladas dos três slots', async () => {
    const accounts = make();
    await accounts.init();
    for (const slot of [1, 2, 3] as const) {
      expect(existsSync(join(home, 'accounts', 'claude', String(slot)))).toBe(true);
      expect(accounts.env(slot)).toEqual({ CLAUDE_CONFIG_DIR: accounts.dir(slot) });
    }
    expect(new Set([1, 2, 3].map((s) => accounts.dir(s as 1 | 2 | 3))).size).toBe(3);
  });

  it('lista estado, e-mail e plano sem expor o token', async () => {
    const accounts = make();
    await accounts.init();
    const state = await accounts.list();
    expect(state.contas.map((c) => [c.slot, c.logada])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(state.contas[0]).toMatchObject({ email: 'a@b.dev', plano: 'max', apelido: 'Conta 1' });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(runs.every((r) => r.args.join(' ') === 'auth status')).toBe(true);
  });

  it('persiste apelido e conta ativa sem segredos', async () => {
    const first = make();
    await first.init();
    await first.rename(2, '  Trabalho  ');
    await first.setActive(2);
    const second = make();
    await second.init();
    const state = await second.list();
    expect(state.ativa).toBe(2);
    expect(state.contas[1]).toMatchObject({ apelido: 'Trabalho', ativa: true });
    await second.setActive(undefined);
    expect((await make().list()).ativa).toBeUndefined();
  });

  it('prepara o login com o ambiente do slot e sai pelo CLI', async () => {
    const accounts = make();
    const prep = await accounts.prepare(3);
    expect(prep.env).toEqual({ CLAUDE_CONFIG_DIR: join(home, 'accounts', 'claude', '3') });
    expect(prep.comando).toBe('claude auth login');
    await accounts.logout(3);
    expect(runs[0]).toMatchObject({
      args: ['auth', 'logout'],
      env: { CLAUDE_CONFIG_DIR: prep.dir },
    });
  });

  it('só aceita os slots 1 a 3 pela API', async () => {
    const accounts = make();
    const router = new Router();
    accounts.register(router);
    await expect(router.dispatch('claude.accounts.setActive', { slot: 4 }, call)).rejects.toThrow(
      /slot/,
    );
    await router.dispatch('claude.accounts.setActive', { slot: 3 }, call);
    expect(accounts.active).toBe(3);
    await router.dispatch('claude.accounts.setActive', { slot: null }, call);
    expect(accounts.active).toBeUndefined();
  });

  it('não troca os agentes abertos para uma conta sem login', async () => {
    const switched: unknown[] = [];
    const accounts = new ClaudeAccounts({
      home,
      file: join(home, 'data', 'claude-accounts.json'),
      runClaude,
      onSwitch: (slot) => {
        switched.push(slot);
        return Promise.resolve(['s1']);
      },
    });
    const semLogin = await accounts.activate(2);
    expect(accounts.active).toBe(2);
    expect(semLogin?.sessoes).toEqual([]);
    const logada = await accounts.activate(1);
    expect(logada?.sessoes).toEqual(['s1']);
    expect(switched).toEqual([1]);
  });

  it('parseAuthStatus descarta tudo que não é logada, e-mail e plano', () => {
    expect(parseAuthStatus(`{"loggedIn":true,"token":"${SECRET}"}`)).toEqual({ logada: true });
    expect(parseAuthStatus('não é json')).toEqual({});
  });

  describe('agentes', () => {
    const started: StartOptions[] = [];
    const adapter: AgentAdapter = {
      id: 'falso',
      detect: () => Promise.resolve({ status: 'pronto' }),
      start: (options) => {
        started.push(options);
        return Promise.resolve({
          state: 'ocioso',
          onEvent: () => ({ dispose: () => undefined }),
          usage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          sessionOptions: () => [],
          stop: () => Promise.resolve(),
        } as unknown as AgentHandle);
      },
    };

    function runtime(accounts: ClaudeAccounts): AgentRuntime {
      return new AgentRuntime(new EventBus(), {
        profiles: [
          { id: 'claude', nome: 'Claude', provedor: 'anthropic', adaptador: 'acp' },
          { id: 'codex', nome: 'Codex', provedor: 'openai', adaptador: 'acp' },
        ],
        adapterFor: () => adapter,
        claudeAccounts: accounts,
      });
    }

    beforeEach(() => {
      started.length = 0;
    });

    it('usa a conta pedida, senão a ativa, e isola o ambiente', async () => {
      const accounts = make();
      await accounts.init();
      await accounts.rename(2, 'Pessoal');
      await accounts.setActive(1);
      const agents = runtime(accounts);

      await agents.launch({ profileId: 'claude', cwd: home });
      expect(started[0]?.env?.CLAUDE_CONFIG_DIR).toBe(accounts.dir(1));

      await agents.launch({ profileId: 'claude', cwd: home, claudeAccount: 2 });
      expect(started[1]?.env?.CLAUDE_CONFIG_DIR).toBe(accounts.dir(2));

      const infos = agents.list();
      expect(infos.map((i) => i.contaClaude)).toEqual([
        { slot: 1, apelido: 'Conta 1' },
        { slot: 2, apelido: 'Pessoal' },
      ]);
      await agents.stopAll();
    });

    it('sem conta ativa e para outros provedores, não mexe no ambiente', async () => {
      const accounts = make();
      await accounts.init();
      const agents = runtime(accounts);
      await agents.launch({ profileId: 'claude', cwd: home });
      await accounts.setActive(3);
      await agents.launch({ profileId: 'codex', cwd: home });
      expect(started[0]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(started[1]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(agents.list().every((i) => i.contaClaude === undefined)).toBe(true);
      await agents.stopAll();
    });
  });
});
