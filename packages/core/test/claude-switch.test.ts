import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter, AgentEvent, AgentHandle, StartOptions } from '@fakl/agents';
import type {
  AgentState,
  AgentStateEventData,
  ClaudeAccountAttribution,
  ClaudeAccountEventData,
  FaklEvent,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  AgentSessionStore,
  ClaudeAccounts,
  EventBus,
  pruneAttribution,
  Router,
  type ClaudeRunner,
} from '../src/index.js';
import { waitFor } from './helpers.js';

const call = { connectionId: 'c', notify: () => undefined, onClose: () => undefined };
const runClaude: ClaudeRunner = () => Promise.resolve({ code: 0, stdout: '{}' });
const DAY = 86_400_000;

/** O arquivo de atribuição como está no disco agora. */
function attributionOf(accounts: ClaudeAccounts): ClaudeAccountAttribution {
  return JSON.parse(readFileSync(accounts.attributionFile(), 'utf8')) as ClaudeAccountAttribution;
}

/** Agente falso que a gente controla: muda de estado e responde quando o teste manda. */
interface FakeHandle extends AgentHandle {
  state: AgentState;
  readonly options: StartOptions;
  stopped: boolean;
  set(state: AgentState): void;
  say(text: string): void;
}

function fakeHandle(options: StartOptions): FakeHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const handle: FakeHandle = {
    state: 'ocioso',
    options,
    stopped: false,
    remoteSessionId: options.resume?.sessionId ?? 'acp-1',
    resumedAs: options.resume ? (options.resume.sessionId ? 'sessão' : 'histórico') : undefined,
    set(state) {
      const previous = handle.state;
      handle.state = state;
      emit({ type: 'state', state, previous });
    },
    say(text) {
      emit({ type: 'output', kind: 'message', text });
    },
    send: () => Promise.resolve(),
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    respondPermission: () => Promise.resolve(),
    setPermissions: () => undefined,
    sessionOptions: () => [],
    setOption: () => Promise.resolve(),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    stop(reason) {
      handle.stopped = true;
      const previous = handle.state;
      handle.state = 'parado';
      emit({ type: 'state', state: 'parado', previous, reason });
      return Promise.resolve();
    },
    usage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  };
  return handle;
}

describe('contas do Claude: histórico compartilhado', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-shared-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('liga projects de cada slot à pasta comum e migra o que já existia', async () => {
    const accounts = new ClaudeAccounts({ home, runClaude });
    const slotProjects = join(accounts.dir(1), 'projects');
    const shared = accounts.sharedProjects();
    // Conversas antigas na conta 1 e uma versão menor da mesma na pasta comum.
    await mkdir(join(slotProjects, 'repo'), { recursive: true });
    await writeFile(join(slotProjects, 'repo', 'a.jsonl'), 'conversa inteira\n');
    await writeFile(join(slotProjects, 'repo', 'b.jsonl'), 'só no slot\n');
    await mkdir(join(shared, 'repo'), { recursive: true });
    await writeFile(join(shared, 'repo', 'a.jsonl'), 'curta\n');
    await writeFile(join(shared, 'repo', 'c.jsonl'), 'uma conversa bem maior que a do slot\n');
    await writeFile(join(slotProjects, 'repo', 'c.jsonl'), 'menor\n');

    await accounts.init();
    for (const slot of [1, 2, 3] as const) {
      const link = join(accounts.dir(slot), 'projects');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(join(shared, 'repo', 'a.jsonl'), 'utf8')).toBe('conversa inteira\n');
    expect(await readFile(join(shared, 'repo', 'b.jsonl'), 'utf8')).toBe('só no slot\n');
    expect(await readFile(join(shared, 'repo', 'c.jsonl'), 'utf8')).toContain('bem maior');
    // Quem perde a colisão fica ao lado, com .bak: nada é apagado.
    expect(await readFile(join(shared, 'repo', 'a.anterior.jsonl.bak'), 'utf8')).toBe('curta\n');
    expect(await readFile(join(shared, 'repo', 'c.slot1.jsonl.bak'), 'utf8')).toBe('menor\n');
    // A pasta de migração some quando fica vazia.
    expect((await readdir(accounts.dir(1))).filter((n) => n.startsWith('projects.'))).toEqual([]);
    // A conversa gravada por uma conta aparece nas outras.
    await writeFile(join(accounts.dir(2), 'projects', 'repo', 'nova.jsonl'), 'x');
    expect(existsSync(join(accounts.dir(3), 'projects', 'repo', 'nova.jsonl'))).toBe(true);

    // De novo: já está certo, nada muda.
    await accounts.init();
    expect(await readFile(join(accounts.dir(1), 'projects', 'repo', 'a.jsonl'), 'utf8')).toBe(
      'conversa inteira\n',
    );
    expect((await stat(join(home, 'accounts', 'claude', 'shared'))).isDirectory()).toBe(true);

    // O uso antigo das conversas migradas continua na conta 1, desde sempre.
    const attribution = attributionOf(accounts);
    for (const id of ['a', 'b', 'c']) {
      expect(attribution.sessoes[id]).toEqual([{ slot: 1, desde: 0 }]);
    }
    expect(attribution.migradoEm).toBeGreaterThan(0);
    // Sem conta ativa ao iniciar: a padrão do CLI vale daqui em diante.
    expect(attribution.ativas).toHaveLength(1);
    expect(attribution.ativas[0]?.slot).toBeNull();
  });

  it('não mexe em nada se o projects do slot não pode ser renomeado (arquivo aberto)', async () => {
    const slotProjects = join(home, 'accounts', 'claude', '1', 'projects');
    await mkdir(join(slotProjects, 'repo'), { recursive: true });
    await writeFile(join(slotProjects, 'repo', 'aberta.jsonl'), 'em uso\n');
    const busy = new ClaudeAccounts({
      home,
      runClaude,
      moveDir: () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })),
    });
    await busy.init();
    expect((await lstat(slotProjects)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(slotProjects, 'repo', 'aberta.jsonl'), 'utf8')).toBe('em uso\n');
    expect(existsSync(join(busy.sharedProjects(), 'repo', 'aberta.jsonl'))).toBe(false);
    expect((await readdir(busy.dir(1))).filter((n) => n.startsWith('projects.'))).toEqual([]);

    // No próximo início, com o arquivo livre, migra.
    const free = new ClaudeAccounts({ home, runClaude });
    await free.init();
    expect((await lstat(slotProjects)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(free.sharedProjects(), 'repo', 'aberta.jsonl'), 'utf8')).toBe(
      'em uso\n',
    );
  });

  it('reprocessa a pasta de migração que sobrou de um início anterior', async () => {
    const accounts = new ClaudeAccounts({ home, runClaude });
    const staging = join(accounts.dir(2), 'projects.migrando-123');
    await mkdir(join(staging, 'repo'), { recursive: true });
    await writeFile(join(staging, 'repo', 'x.jsonl'), 'sobrou\n');
    await writeFile(join(staging, 'repo', 'y.jsonl'), 'y\n');
    await mkdir(join(accounts.sharedProjects(), 'repo'), { recursive: true });
    await writeFile(join(accounts.sharedProjects(), 'repo', 'y.jsonl'), 'y maior na comum\n');

    await accounts.init();
    const shared = join(accounts.sharedProjects(), 'repo');
    expect(await readFile(join(shared, 'x.jsonl'), 'utf8')).toBe('sobrou\n');
    expect(await readFile(join(shared, 'y.jsonl'), 'utf8')).toBe('y maior na comum\n');
    expect(await readFile(join(shared, 'y.slot2.jsonl.bak'), 'utf8')).toBe('y\n');
    expect(existsSync(staging)).toBe(false);
    expect(attributionOf(accounts).sessoes.x).toEqual([{ slot: 2, desde: 0 }]);
  });

  it('serializa ativações e não publica a que foi superada antes de começar', async () => {
    const published: (number | undefined)[] = [];
    let release: (() => void) | undefined;
    const accounts = new ClaudeAccounts({
      home,
      runClaude,
      onSwitch: async (slot) => {
        if (slot === 1) await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
      publish: (data) => published.push(data.ativa),
    });
    await accounts.init();
    const first = accounts.activate(1);
    await waitFor(() => release !== undefined);
    // Com a primeira em andamento: a 2 é superada pela 3 antes de começar.
    const second = accounts.activate(2);
    const third = accounts.activate(3);
    release?.();
    expect(await first).toMatchObject({ ativa: 1 });
    expect(await second).toBeUndefined();
    expect(await third).toMatchObject({ ativa: 3 });
    expect(published).toEqual([1, 3]);
    expect(accounts.active).toBe(3);
    expect(attributionOf(accounts).ativas.map((entry) => entry.slot)).toEqual([null, 1, 3]);
  });

  it('registra cada troca de conta ativa e informa os caminhos na lista', async () => {
    const accounts = new ClaudeAccounts({ home, runClaude });
    await accounts.init();
    await accounts.activate(2);
    await accounts.activate(undefined);
    expect(attributionOf(accounts).ativas.map((entry) => entry.slot)).toEqual([null, 2, null]);
    const times = attributionOf(accounts).ativas.map((entry) => entry.desde);
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // Reiniciar não acrescenta nada: a lista já tem história.
    const again = new ClaudeAccounts({ home, runClaude });
    await again.init();
    expect(attributionOf(again).ativas).toHaveLength(3);

    const state = await again.list();
    expect(state.compartilhada).toBe(again.sharedProjects());
    expect(state.atribuicao).toBe(join(home, 'accounts', 'claude', 'shared', 'contas.json'));
  });

  it('poda pela atividade e guarda a última entrada antes do corte de cada linha do tempo', () => {
    const now = 100 * DAY;
    const pruned = pruneAttribution(
      {
        ativas: [
          { slot: 1, desde: 10 * DAY },
          { slot: 2, desde: 80 * DAY },
          { slot: 3, desde: 95 * DAY },
        ],
        sessoes: {
          velha: [{ slot: 1, desde: 50 * DAY }],
          longa: [
            { slot: 1, desde: 40 * DAY },
            { slot: 2, desde: 50 * DAY },
          ],
          nova: [
            { slot: 1, desde: 50 * DAY },
            { slot: 2, desde: 99 * DAY },
          ],
          migrada: [{ slot: 3, desde: 0 }],
        },
        vistas: { longa: 99 * DAY, sumida: 99 * DAY },
        migradoEm: 98 * DAY,
      },
      now,
    );
    expect(pruned.ativas.map((entry) => entry.slot)).toEqual([2, 3]);
    // A sessão longa, com atividade recente, fica com a entrada que ainda vale.
    expect(Object.keys(pruned.sessoes).sort()).toEqual(['longa', 'migrada', 'nova']);
    expect(pruned.sessoes.longa).toEqual([{ slot: 2, desde: 50 * DAY }]);
    expect(pruned.sessoes.nova).toEqual([
      { slot: 1, desde: 50 * DAY },
      { slot: 2, desde: 99 * DAY },
    ]);
    expect(pruned.vistas).toEqual({ longa: 99 * DAY });
    // Passados 8 dias da migração, as migradas saem também.
    expect(Object.keys(pruneAttribution(pruned, 107 * DAY).sessoes).sort()).toEqual([
      'longa',
      'nova',
    ]);
  });
});

describe('contas do Claude: troca nos agentes abertos', () => {
  let home: string;
  let bus: EventBus;
  let events: FaklEvent[];
  let handles: FakeHandle[];
  let accounts: ClaudeAccounts;
  let store: AgentSessionStore;
  /** Enquanto existir, os agentes novos só sobem quando ela resolver. */
  let gate: Promise<void> | undefined;
  let starts: number;

  const adapter: AgentAdapter = {
    id: 'falso',
    detect: () => Promise.resolve({ status: 'pronto' }),
    start: async (options) => {
      starts++;
      await gate;
      const handle = fakeHandle(options);
      handles.push(handle);
      return handle;
    },
  };
  const profiles = [
    { id: 'claude', nome: 'Claude', provedor: 'anthropic', adaptador: 'acp' as const },
    { id: 'codex', nome: 'Codex', provedor: 'openai', adaptador: 'acp' as const },
  ];

  function runtime(): AgentRuntime {
    return new AgentRuntime(bus, {
      profiles,
      adapterFor: () => adapter,
      claudeAccounts: accounts,
      store,
      home,
    });
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-switch-'));
    bus = new EventBus();
    events = [];
    handles = [];
    gate = undefined;
    starts = 0;
    bus.subscribe(['agent.*', 'claude.*'], (event) => events.push(event));
    accounts = new ClaudeAccounts({ home, runClaude });
    await accounts.init();
    await accounts.rename(2, 'Trabalho');
    store = new AgentSessionStore({ dir: join(home, 'data', 'agents') });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  const reasons = (id: string): string[] =>
    events
      .filter((e) => e.topic === 'agent.state' && e.subject === id)
      .map((e) => (e.data as AgentStateEventData).reason ?? '');

  it('reabre a sessão ociosa na conta nova, com o mesmo id e a mesma conversa', async () => {
    await accounts.setActive(1);
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    const first = handles[0];
    agents.send(sessionId, 'olá');
    first?.set('pensando');
    first?.say('resposta da conta 1');
    first?.set('ocioso');

    const affected = await agents.switchClaudeAccount(2);
    expect(affected).toEqual([sessionId]);
    await waitFor(() => handles.length === 2);
    expect(first?.stopped).toBe(true);
    const second = handles[1];
    expect(second?.options.env).toMatchObject({
      FAKL_AGENT_SESSION: sessionId,
      CLAUDE_CONFIG_DIR: accounts.dir(2),
    });
    // A mesma sessão do Claude Code, carregada na conta nova.
    expect(second?.options.resume?.sessionId).toBe('acp-1');
    await waitFor(() => agents.list()[0]?.contaClaude?.slot === 2);
    const [info] = agents.list();
    expect(info).toMatchObject({
      sessionId,
      state: 'ocioso',
      contaClaude: { slot: 2, apelido: 'Trabalho' },
    });
    expect(agents.claudeSlots().get(sessionId)).toBe(2);
    // A sessão do Claude Code passa a contar na conta 2 a partir da troca.
    await waitFor(() => attributionOf(accounts).sessoes['acp-1']?.length === 2);
    expect(attributionOf(accounts).sessoes['acp-1']?.map((entry) => entry.slot)).toEqual([1, 2]);
    // A conversa da memória continua, e o agente antigo saiu sem virar "parado".
    const { items } = await agents.transcript(sessionId);
    expect(items.some((i) => i.kind === 'agent' && i.text === 'resposta da conta 1')).toBe(true);
    expect(reasons(sessionId)).toContain('conta trocada para Trabalho');
    expect(
      events.some(
        (e) =>
          e.topic === 'agent.state' &&
          e.subject === sessionId &&
          (e.data as AgentStateEventData).state === 'parado',
      ),
    ).toBe(false);
    await agents.stopAll();
  });

  it('avisa que está trocando e deixa a parada pedida durante a troca encerrar a sessão', async () => {
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    let open: (() => void) | undefined;
    gate = new Promise<void>((resolve) => (open = resolve));
    const switching = agents.switchClaudeAccount(2);
    expect(agents.stateOf(sessionId)).toBe('preparando');
    expect(reasons(sessionId)).toContain('trocando para a conta Trabalho');
    // O agente novo está subindo quando a parada chega.
    await waitFor(() => starts === 2);
    const stopping = agents.stop(sessionId, 'maestro');
    open?.();
    await stopping;
    await switching;
    await agents.settled(sessionId);
    expect(agents.stateOf(sessionId)).toBe('parado');
    expect(handles).toHaveLength(2);
    expect(handles.every((h) => h.stopped && h.state === 'parado')).toBe(true);
    expect(agents.list()[0]).toMatchObject({ state: 'parado', retomavel: true });
    await agents.stopAll();
  });

  it('parada pedida antes de o agente novo começar a subir não abre agente nenhum', async () => {
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    const switching = agents.switchClaudeAccount(2);
    await agents.stop(sessionId, 'usuário');
    await switching;
    expect(starts).toBe(1);
    expect(handles[0]?.stopped).toBe(true);
    expect(agents.stateOf(sessionId)).toBe('parado');
    const last = events.filter((e) => e.topic === 'agent.state' && e.subject === sessionId).at(-1);
    expect(last?.data).toMatchObject({ state: 'parado', previous: 'preparando' });
    await agents.stopAll();
  });

  it('a troca adiada não reabre a sessão que foi parada', async () => {
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    handles[0]?.set('pensando');
    await agents.switchClaudeAccount(3);
    await agents.stop(sessionId, 'usuário');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(starts).toBe(1);
    expect(agents.stateOf(sessionId)).toBe('parado');
    await agents.stopAll();
  });

  it('espera a vez acabar para trocar quem está trabalhando', async () => {
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    const first = handles[0];
    first?.set('pensando');

    expect(await agents.switchClaudeAccount(3)).toEqual([sessionId]);
    // Nada é interrompido no meio da vez.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first?.stopped).toBe(false);
    expect(handles).toHaveLength(1);

    first?.set('ocioso');
    await waitFor(() => handles.length === 2);
    expect(handles[1]?.options.env?.CLAUDE_CONFIG_DIR).toBe(accounts.dir(3));
    await waitFor(() => agents.list()[0]?.contaClaude?.slot === 3);
    await agents.stopAll();
  });

  it('não mexe em outros provedores nem em quem já está na conta', async () => {
    await accounts.setActive(2);
    const agents = runtime();
    await agents.launch({ profileId: 'claude', cwd: home });
    await agents.launch({ profileId: 'codex', cwd: home });
    expect(await agents.switchClaudeAccount(2)).toEqual([]);
    expect(handles.every((h) => !h.stopped)).toBe(true);
    await agents.stopAll();
  });

  it('guarda a conta na sessão e retoma com ela; a dormente só muda a conta guardada', async () => {
    const before = runtime();
    const { sessionId } = await before.launch({
      profileId: 'claude',
      cwd: home,
      claudeAccount: 2,
    });
    await before.stopAll();
    const saved = JSON.parse(
      await readFile(join(home, 'data', 'agents', `${sessionId}.json`), 'utf8'),
    ) as { contaClaude?: number };
    expect(saved.contaClaude).toBe(2);

    // Core reiniciado com outra conta ativa: a sessão volta na conta dela, não na ativa.
    await accounts.setActive(1);
    const after = runtime();
    await after.load();
    expect(after.list()[0]?.contaClaude).toEqual({ slot: 2, apelido: 'Trabalho' });
    const router = new Router();
    after.register(router);
    await router.dispatch('agents.resume', { sessionId }, call);
    expect(handles.at(-1)?.options.env?.CLAUDE_CONFIG_DIR).toBe(accounts.dir(2));
    await after.stopAll();

    // Dormente: só a conta guardada muda, sem abrir agente.
    const third = runtime();
    await third.load();
    const opened = handles.length;
    expect(await third.switchClaudeAccount(3)).toEqual([sessionId]);
    expect(handles).toHaveLength(opened);
    expect(third.list()[0]?.contaClaude?.slot).toBe(3);
    const disk = JSON.parse(
      await readFile(join(home, 'data', 'agents', `${sessionId}.json`), 'utf8'),
    ) as { contaClaude?: number };
    expect(disk.contaClaude).toBe(3);
    // Voltar à conta padrão tira a conta guardada: ao retomar, vale a ativa.
    await third.switchClaudeAccount(undefined);
    expect(third.list()[0]?.contaClaude).toBeUndefined();
    await accounts.setActive(undefined);
    const thirdRouter = new Router();
    third.register(thirdRouter);
    await thirdRouter.dispatch('agents.resume', { sessionId }, call);
    expect(handles.at(-1)?.options.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    await third.stopAll();
  });

  it('sessão encerrada viva troca a conta com que vai voltar', async () => {
    const agents = runtime();
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home, claudeAccount: 1 });
    await agents.stop(sessionId, 'usuário');
    expect(await agents.switchClaudeAccount(2)).toEqual([sessionId]);
    const router = new Router();
    agents.register(router);
    await router.dispatch('agents.resume', { sessionId }, call);
    expect(handles.at(-1)?.options.env?.CLAUDE_CONFIG_DIR).toBe(accounts.dir(2));
    await agents.stopAll();
  });

  it('setActive pela API troca os abertos e publica claude.account', async () => {
    const agents = runtime();
    const withSwitch = new ClaudeAccounts({
      home,
      runClaude,
      onSwitch: (slot) => agents.switchClaudeAccount(slot),
      publish: (data) => bus.publish('claude.account', 'claude', data),
    });
    const { sessionId } = await agents.launch({ profileId: 'claude', cwd: home });
    const router = new Router();
    withSwitch.register(router);

    const state = (await router.dispatch('claude.accounts.setActive', { slot: 2 }, call)) as {
      ativa?: number;
    };
    expect(state.ativa).toBe(2);
    const event = events.find((e) => e.topic === 'claude.account');
    expect(event?.subject).toBe('claude');
    expect(event?.data as ClaudeAccountEventData).toEqual({
      ativa: 2,
      dir: accounts.dir(2),
      env: { CLAUDE_CONFIG_DIR: accounts.dir(2) },
      sessoes: [sessionId],
    });
    await waitFor(() => handles.length === 2);

    // Só para os novos: os abertos ficam como estão.
    await router.dispatch('claude.accounts.setActive', { slot: 3, aplicarEmAbertos: false }, call);
    const last = events.filter((e) => e.topic === 'claude.account').at(-1);
    expect((last?.data as ClaudeAccountEventData).sessoes).toEqual([]);
    expect(handles).toHaveLength(2);

    // Conta padrão do CLI: env vazio e sem pasta.
    await router.dispatch('claude.accounts.setActive', { slot: null }, call);
    const reset = events.filter((e) => e.topic === 'claude.account').at(-1);
    expect(reset?.data).toEqual({ env: {}, sessoes: [sessionId] });
    await agents.stopAll();
  });
});
