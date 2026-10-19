import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TerminalAdapter,
  adapterForProfile,
  type AgentEvent,
  type AgentHandle,
  type AgentProfile,
  type Disposable,
  type TerminalChannel,
  type TerminalHostLink,
  type TerminalReport,
  type TerminalSpawnRequest,
} from '../src/index.js';

const profile: AgentProfile = {
  id: 'cli',
  nome: 'CLI',
  provedor: 'outro',
  adaptador: 'terminal',
  comando: 'minha-cli',
  args: ['-x'],
  terminal: { prompt: '>$', silencioSegundos: 2 },
};

/** Ponte falsa: guarda o que o adaptador pediu e deixa o teste falar pelo terminal. */
class FakeLink implements TerminalHostLink {
  up = true;
  spawned: TerminalSpawnRequest[] = [];
  written: string[] = [];
  stops = 0;
  private listeners = new Set<(report: TerminalReport) => void>();

  available(): boolean {
    return this.up;
  }

  spawn(request: TerminalSpawnRequest): TerminalChannel {
    this.spawned.push(request);
    return {
      write: (text) => this.written.push(text),
      stop: () => {
        this.stops++;
      },
      onReport: (listener): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
  }

  report(report: TerminalReport): void {
    for (const l of [...this.listeners]) l(report);
  }
}

async function iniciar(
  link: FakeLink,
  permissions: 'perguntar' | 'aprovar-leitura' | 'aprovar-tudo' = 'aprovar-tudo',
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const handle = await new TerminalAdapter(profile, link, { spawnTimeoutMs: 1_000 }).start({
    profile,
    cwd: '/tmp/trabalho',
    permissions,
    env: { FAKL_AGENT_SESSION: 'S1' },
  });
  const events: AgentEvent[] = [];
  handle.onEvent((e) => events.push(e));
  return { handle, events };
}

describe('contrato do adaptador de terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pede o terminal com o comando, os argumentos e a pasta do perfil', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    expect(handle.state).toBe('preparando');
    expect(link.spawned).toEqual([
      {
        sessionId: 'S1',
        nome: 'CLI',
        command: 'minha-cli',
        args: ['-x'],
        cwd: '/tmp/trabalho',
        env: {},
        prompt: '>$',
        silencioSegundos: 2,
      },
    ]);
  });

  it('sem IDE conectada o início falha com um motivo', async () => {
    const link = new FakeLink();
    link.up = false;
    await expect(iniciar(link)).rejects.toThrow(/IDE/);
  });

  it('adapterForProfile devolve o adaptador de terminal', () => {
    expect(adapterForProfile(profile, {}, new FakeLink()).id).toBe('terminal');
  });

  it('segue a heurística: preparando, ocioso, executando e de novo ocioso', async () => {
    const link = new FakeLink();
    const { handle, events } = await iniciar(link);
    link.report({ type: 'ready' });
    expect(handle.state).toBe('preparando');
    link.report({ type: 'state', state: 'ocioso' });
    expect(handle.state).toBe('ocioso');
    link.report({ type: 'state', state: 'executando' });
    link.report({ type: 'output', text: 'linha 1\nlinha 2' });
    expect(handle.state).toBe('executando');
    expect(events.filter((e) => e.type === 'output')).toEqual([
      { type: 'output', kind: 'message', text: 'linha 1\nlinha 2\n' },
    ]);
    expect(handle.usage()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('digita a mensagem limpa quando está ocioso e resolve ao voltar a esperar', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    link.report({ type: 'state', state: 'ocioso' });
    let feito = false;
    const envio = handle.send('faça isto\nagora').then(() => {
      feito = true;
    });
    expect(link.written).toEqual(['faça isto agora']);
    expect(handle.state).toBe('executando');
    await Promise.resolve();
    expect(feito).toBe(false);
    link.report({ type: 'state', state: 'executando' });
    link.report({ type: 'state', state: 'ocioso' });
    await envio;
    expect(feito).toBe(true);
  });

  it('enfileira mensagens enquanto a CLI trabalha e sobe a seguinte quando ela espera', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    void handle.send('primeira');
    void handle.send('segunda');
    // Ainda preparando: nada foi digitado.
    expect(link.written).toEqual([]);
    link.report({ type: 'state', state: 'ocioso' });
    expect(link.written).toEqual(['primeira']);
    link.report({ type: 'state', state: 'executando' });
    link.report({ type: 'state', state: 'ocioso' });
    expect(link.written).toEqual(['primeira', 'segunda']);
  });

  it('em perguntar e aprovar-leitura não digita e avisa o que fazer', async () => {
    for (const modo of ['perguntar', 'aprovar-leitura'] as const) {
      const link = new FakeLink();
      const { handle, events } = await iniciar(link, modo);
      link.report({ type: 'state', state: 'ocioso' });
      await expect(handle.send('oi')).rejects.toThrow(/Assumir o agente/);
      expect(link.written).toEqual([]);
      expect(events.some((e) => e.type === 'error')).toBe(true);
    }
  });

  it('baixar a política tira da fila o que ainda não foi digitado', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    const pendente = handle.send('espera');
    handle.setPermissions('perguntar');
    await expect(pendente).rejects.toThrow();
    link.report({ type: 'state', state: 'ocioso' });
    expect(link.written).toEqual([]);
  });

  it('pausar segura as mensagens; retomar solta', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    link.report({ type: 'state', state: 'ocioso' });
    await handle.pause();
    expect(handle.state).toBe('pausado');
    void handle.send('depois');
    expect(link.written).toEqual([]);
    await handle.resume();
    expect(link.written).toEqual(['depois']);
  });

  it('não há pedido de permissão estruturado nem opções de sessão', async () => {
    const { handle } = await iniciar(new FakeLink());
    await expect(handle.respondPermission('p1', true)).rejects.toThrow();
    expect(handle.sessionOptions()).toEqual([]);
    await expect(handle.setOption('model', 'x')).rejects.toThrow();
  });

  it('o fim do comando conclui ou falha, conforme o código', async () => {
    const ok = new FakeLink();
    const a = await iniciar(ok);
    ok.report({ type: 'exit', code: 0 });
    expect(a.handle.state).toBe('concluído');
    await expect(a.handle.send('x')).rejects.toThrow();

    const ruim = new FakeLink();
    const b = await iniciar(ruim);
    ruim.report({ type: 'exit', code: 3 });
    expect(b.handle.state).toBe('falhou');
    expect(b.events.some((e) => e.type === 'error')).toBe(true);
    expect(ruim.stops).toBe(1);
  });

  it('parar fecha o terminal e deixa o motivo no estado', async () => {
    const link = new FakeLink();
    const { handle, events } = await iniciar(link);
    await handle.stop('maestro');
    expect(link.stops).toBe(1);
    expect(handle.state).toBe('parado');
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'parado', reason: 'maestro' });
  });

  it('sem a extensão confirmar o terminal a tempo, a sessão falha', async () => {
    const link = new FakeLink();
    const { handle } = await iniciar(link);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(handle.state).toBe('falhou');
    expect(link.stops).toBe(1);
  });

  it('detect procura o comando do perfil no PATH', async () => {
    const achou = await new TerminalAdapter(
      { ...profile, comando: process.execPath },
      undefined,
    ).detect();
    expect(achou.status).toBe('pronto');
    const faltou = await new TerminalAdapter(
      { ...profile, comando: 'cli-que-nao-existe-xyz' },
      undefined,
      { hostEnv: { PATH: '' } },
    ).detect();
    expect(faltou.status).toBe('não-instalado');
  });
});
