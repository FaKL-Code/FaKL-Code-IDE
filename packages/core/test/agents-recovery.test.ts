import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { AgentAdapter, AgentEvent, AgentHandle, StartOptions } from '@fakl/agents';
import { AcpAdapter } from '@fakl/agents';
import type { AgentState, FaklEvent } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agents.js';
import { AgentSessionStore } from '../src/agent-store.js';
import { EventBus } from '../src/events/bus.js';
import { Router } from '../src/rpc/router.js';
import { waitFor } from './helpers.js';

class Handle implements AgentHandle {
  state: AgentState = 'ocioso';
  readonly remoteSessionId = 'acp-original';
  readonly sent: string[] = [];
  readonly listeners = new Set<(event: AgentEvent) => void>();
  constructor(readonly options: StartOptions) {}
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  set(state: AgentState): void {
    const previous = this.state;
    this.state = state;
    this.emit({ type: 'state', state, previous });
  }
  send(message: string): Promise<void> {
    this.sent.push(message);
    this.set('pensando');
    return Promise.resolve();
  }
  onEvent(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  respondPermission(): Promise<void> {
    return Promise.resolve();
  }
  setPermissions(): void {
    // A política não muda nada neste agente falso.
  }
  sessionOptions() {
    return [{ id: 'model', nome: 'Modelo', atual: this.model }];
  }
  model = 'chosen';
  setOption(_id: string, value: string | boolean): Promise<void> {
    this.model = String(value);
    return Promise.resolve();
  }
  pause(): Promise<void> {
    this.set('pausado');
    return Promise.resolve();
  }
  resume(): Promise<void> {
    if (this.state === 'pausado') this.set('ocioso');
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.set('parado');
    return Promise.resolve();
  }
  usage() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  limit(message = 'Rate limit exceeded. Retry after 1 second'): void {
    this.emit({ type: 'error', message });
    this.set('ocioso');
  }
}

describe('runtime: retomada de limite', () => {
  let cwd: string;
  let handles: Handle[];
  function handle(index: number): Handle {
    const found = handles.at(index);
    if (!found) throw new Error(`handle ${String(index)} ausente`);
    return found;
  }
  let events: FaklEvent[];
  let bus: EventBus;
  const runtimes: AgentRuntime[] = [];
  let gate: Promise<void> | undefined;
  const adapter: AgentAdapter = {
    id: 'test',
    detect: () => Promise.resolve({ status: 'pronto' }),
    start: async (options) => {
      await gate;
      const handle = new Handle(options);
      handles.push(handle);
      return handle;
    },
  };
  const profile = {
    id: 'claude',
    nome: 'Claude',
    provedor: 'anthropic',
    adaptador: 'acp',
  } as const;
  function runtime(store?: AgentSessionStore): AgentRuntime {
    const agents = new AgentRuntime(bus, {
      profiles: [profile],
      adapterFor: () => adapter,
      home: join(cwd, 'home'),
      ...(store ? { store } : {}),
      claudeAccounts: {
        resolve: (slot) => Promise.resolve(slot ?? 1),
        env: (slot) => ({ TEST_ACCOUNT: String(slot) }),
        ref: (slot) => ({ slot, apelido: String(slot) }),
      },
      sessionMcp: (id) => [{ name: 'task', command: 'fake', args: [id], env: {} }],
    });
    runtimes.push(agents);
    return agents;
  }
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'fakl-recovery-'));
    handles = [];
    events = [];
    gate = undefined;
    bus = new EventBus();
    bus.subscribe(['agent.*'], (event) => events.push(event));
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const agents of runtimes.splice(0)) await agents.stopAll();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  async function launch(agents: AgentRuntime) {
    const { sessionId } = await agents.launch({
      profileId: 'claude',
      cwd,
      taskId: 'task-1',
      systemPrompt: 'contexto original',
      permissions: 'aprovar-leitura',
    });
    agents.send(sessionId, 'implemente o requisito original');
    return sessionId;
  }

  it('pausa apenas limite e limpa recovery antes de enviar continuação manual', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    expect(agents.stateOf(id)).toBe('pausado');
    expect(agents.recoveryOf(id)).toMatchObject({ motivo: 'limite-sessao', automatica: false });
    const observed: unknown[] = [];
    bus.subscribe(['agent.recovery', 'agent.prompt'], (e) => observed.push(e.data));
    await agents.resume(id);
    expect(agents.recoveryOf(id)).toBeUndefined();
    expect(handle(0).sent).toHaveLength(2);
    expect(handle(0).sent[1]).toContain('Continue');
    expect(observed[0]).toEqual({ retomada: null });
    expect(agents.stateOf(id)).toBe('pensando');
  });

  it('reconhece resposta normal Claude fragmentada só ao terminar a vez', async () => {
    const agents = runtime();
    const id = await launch(agents);
    const h = handle(0);
    h.emit({ type: 'output', kind: 'message', text: "You've hit your " });
    h.emit({ type: 'output', kind: 'message', text: 'limit · resets 5pm (America/Sao_Paulo)' });
    h.set('ocioso');
    expect(agents.recoveryOf(id)?.motivo).toBe('limite-sessao');
    expect(agents.stateOf(id)).toBe('pausado');
  });

  it('preserva finalização legítima, código e erro genérico', async () => {
    const agents = runtime();
    const id = await launch(agents);
    const h = handle(0);
    h.emit({
      type: 'output',
      kind: 'message',
      text: '```ts\nthrow new Error("Rate limit exceeded")\n```',
    });
    h.set('ocioso');
    expect(agents.recoveryOf(id)).toBeUndefined();
    h.emit({ type: 'error', message: 'Network connection failed' });
    h.set('falhou');
    expect(agents.stateOf(id)).toBe('falhou');
    expect(agents.recoveryOf(id)).toBeUndefined();
  });

  it('troca conta aguardando limite com mesma sessão, contexto, opções e MCP, sem novo prompt', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    await agents.switchClaudeAccount(2);
    expect(handles).toHaveLength(2);
    const second = handle(1);
    expect(second.options).toMatchObject({
      cwd,
      permissions: 'aprovar-leitura',
      env: { TEST_ACCOUNT: '2' },
      resume: { sessionId: 'acp-original' },
    });
    expect(second.options.systemPrompt).toContain('contexto original');
    expect(second.options.resume?.history).toContain('requisito original');
    expect(second.options.mcpServers?.[0]).toMatchObject({ args: [id] });
    expect(second.sent).toHaveLength(1);
    expect(agents.list()[0]?.taskId).toBe('task-1');
    expect(agents.recoveryOf(id)).toBeUndefined();
  });

  it('revive tarefa encerrada sem store usando conversa em memória', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).emit({ type: 'output', kind: 'message', text: 'trabalho parcial' });
    await agents.stop(id, 'usuário');
    await agents.resume(id);
    expect(handles).toHaveLength(2);
    expect(handle(1).options.resume?.history).toContain('trabalho parcial');
    expect(agents.list()[0]?.taskId).toBe('task-1');
  });

  it('persiste tarefa, conversa, preferência e recovery no reinício e não esquece tarefas', async () => {
    const store = new AgentSessionStore({ dir: join(cwd, 'sessions') });
    const before = runtime(store);
    const id = await launch(before);
    handle(0).limit();
    await before.setAutoResume(id, true);
    await before.stopAll();
    const after = runtime(store);
    await after.load();
    expect(after.list()[0]).toMatchObject({
      sessionId: id,
      taskId: 'task-1',
      retomada: { automatica: true },
    });
    expect(after.sessionProfile(id)?.taskId).toBe('task-1');
    await after.forget(id);
    expect(after.list()).toHaveLength(1);
    await after.resume(id);
    expect(handle(-1).options.resume?.history).toContain('requisito original');
    expect(handle(-1).sent).toHaveLength(1);
  });

  it('opt-in agenda, não mantém processo vivo e limite repetido respeita atraso mínimo', async () => {
    vi.useFakeTimers();
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(handle(0).sent).toHaveLength(1);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await agents.setAutoResume(id, true);
    expect((timer.mock.results.at(-1)?.value as NodeJS.Timeout | undefined)?.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(handle(0).sent).toHaveLength(2);
    handle(0).limit();
    expect(agents.recoveryOf(id)?.automatica).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(handle(0).sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(handle(0).sent).toHaveLength(3);
  });

  it.each(['stop', 'stopAll', 'disable'] as const)('cancela timer: %s', async (operation) => {
    vi.useFakeTimers();
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    await agents.setAutoResume(id, true);
    if (operation === 'stop') await agents.stop(id, 'usuário');
    else if (operation === 'stopAll') await agents.stopAll();
    else await agents.setAutoResume(id, false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(handles).toHaveLength(1);
    expect(handle(0).sent).toHaveLength(1);
  });

  it('parar durante troca de conta impede continuação', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const switching = agents.switchClaudeAccount(2);
    const stopping = agents.stop(id, 'usuário');
    open();
    await Promise.all([switching, stopping]);
    expect(handle(-1).sent).toHaveLength(handles.length === 1 ? 1 : 0);
    expect(agents.stateOf(id)).toBe('parado');
  });

  it('RPC usa mesma retomada e valida preferência booleana', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    const router = new Router();
    agents.register(router);
    const call = { connectionId: 'c', notify: () => undefined, onClose: () => undefined };
    await expect(
      router.dispatch('agents.setAutoResume', { sessionId: id, automatica: 'yes' }, call),
    ).rejects.toThrow();
    await router.dispatch('agents.setAutoResume', { sessionId: id, automatica: true }, call);
    expect(agents.recoveryOf(id)?.automatica).toBe(true);
    await router.dispatch('agents.resume', { sessionId: id }, call);
    expect(handle(0).sent).toHaveLength(2);
  });

  it.each(['error', 'notice'])('ACP real pausa %s e continua uma única vez', async (mode) => {
    const agents = new AgentRuntime(bus, {
      profiles: [profile],
      adapterFor: () =>
        new AcpAdapter({
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./fixtures/session-limit-agent.mjs', import.meta.url)),
            mode,
          ],
        }),
    });
    runtimes.push(agents);
    const id = await launch(agents);
    await waitFor(() => agents.recoveryOf(id) !== undefined, 8000).catch(() => {
      throw new Error(`Nenhum limite reconhecido: ${JSON.stringify(events)}`);
    });
    await waitFor(() => agents.stateOf(id) === 'pausado');
    await agents.resume(id);
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.output' && (e.data as { text: string }).text === 'continuado: 2',
        ),
      8000,
    );
    expect(agents.recoveryOf(id)).toBeUndefined();
    expect(events.filter((e) => e.topic === 'agent.prompt' && e.subject === id)).toHaveLength(2);
  });

  it('sem reset conhecido sonda apenas após cinco minutos', async () => {
    vi.useFakeTimers();
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit('Session limit reached');
    await agents.setAutoResume(id, true);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(handle(0).sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle(0).sent).toHaveLength(2);
  });

  it('retomadas concorrentes enviam apenas uma continuação', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    await Promise.all([agents.resume(id), agents.resume(id), agents.resume(id)]);
    expect(handle(0).sent).toHaveLength(2);
  });

  it('parar durante revive não deixa continuação nem pedido de parada pendente', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).limit();
    handle(0).set('falhou');
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const resuming = agents.resume(id);
    await waitFor(() => handle(0).state === 'falhou');
    const stopping = agents.stop(id, 'usuário');
    open();
    await Promise.all([resuming, stopping]);
    expect(handle(-1).sent).toHaveLength(0);
    expect(agents.stateOf(id)).toBe('parado');
  });

  it('preserva pausa por limite ao carregar registro do disco', async () => {
    const store = new AgentSessionStore({ dir: join(cwd, 'sessions') });
    const before = runtime(store);
    const id = await launch(before);
    handle(0).limit();
    await before.stopAll();
    const after = runtime(store);
    await after.load();
    expect(after.stateOf(id)).toBe('pausado');
  });

  it('stop durante atualização da conta dormente impede reabertura', async () => {
    const store = new AgentSessionStore({ dir: join(cwd, 'sessions') });
    const before = runtime(store);
    const id = await launch(before);
    handle(0).limit();
    await before.stopAll();
    const after = runtime(store);
    await after.load();
    const switching = after.switchClaudeAccount(2);
    const stopping = after.stop(id, 'usuário');
    await Promise.all([switching, stopping]);
    expect(handles).toHaveLength(1);
  });

  it('reabertura por limite não publica estado ocioso antes de recovery=null', async () => {
    const agents = runtime();
    await launch(agents);
    handle(0).limit();
    const start = events.length;
    await agents.switchClaudeAccount(2);
    const emitted = events.slice(start);
    const cleared = emitted.findIndex(
      (e) => e.topic === 'agent.recovery' && (e.data as { retomada: unknown }).retomada === null,
    );
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(
      emitted
        .slice(0, cleared)
        .some((e) => e.topic === 'agent.state' && (e.data as { state: string }).state === 'ocioso'),
    ).toBe(false);
  });

  it('tarefa conserva branch e trabalho no reinício com fallback pelo diário', async () => {
    const repo = join(cwd, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    await writeFile(join(repo, 'initial.txt'), 'initial');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    const store = new AgentSessionStore({ dir: join(cwd, 'sessions') });
    const before = runtime(store);
    const { sessionId: id, worktree } = await before.launch({
      profileId: 'claude',
      cwd: repo,
      taskId: 'task-branch',
      worktree: true,
    });
    if (!worktree) throw new Error('worktree ausente');
    before.send(id, 'pedido com contexto');
    await writeFile(join(worktree.path, 'partial.txt'), 'partial');
    handle(0).limit();
    await before.stopAll();
    expect(existsSync(worktree.path)).toBe(false);
    const after = runtime(store);
    await after.load();
    await after.resume(id);
    expect(after.list()[0]).toMatchObject({ sessionId: id, taskId: 'task-branch', worktree });
    expect(handle(-1).options.resume?.history).toContain('pedido com contexto');
    expect(await readFile(join(worktree.path, 'partial.txt'), 'utf8')).toBe('partial');
  });

  it('não trata explicação normal de rate limit como limite real', async () => {
    const agents = runtime();
    const id = await launch(agents);
    handle(0).emit({
      type: 'output',
      kind: 'message',
      text: 'Rate limit exceeded is the error you should handle with a retry.',
    });
    handle(0).set('ocioso');
    expect(agents.recoveryOf(id)).toBeUndefined();
  });

  it('automatização reinicia do disco somente após reset e mantém preferência na próxima ocorrência', async () => {
    const store = new AgentSessionStore({ dir: join(cwd, 'sessions') });
    const before = runtime(store);
    const id = await launch(before);
    await before.setAutoResume(id, true);
    handle(0).limit('Session limit reached');
    await before.stopAll();
    vi.useFakeTimers();
    const after = runtime(store);
    await after.load();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(handles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(handles).toHaveLength(2);
    });
    handle(1).limit();
    expect(after.recoveryOf(id)?.automatica).toBe(true);
  });
});
