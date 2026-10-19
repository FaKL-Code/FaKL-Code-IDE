import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TerminalAgentHost,
  type HostExecution,
  type HostShellIntegration,
  type HostTerminal,
  type TerminalWindowApi,
} from '../src/terminal-agent-host.js';

/** Fluxo que o teste alimenta à mão, como o `read()` da integração de shell. */
class FakeExecution implements HostExecution {
  private queue: string[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(data: string): void {
    this.queue.push(data);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *read(): AsyncIterable<string> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }
}

class FakeTerminal implements HostTerminal {
  shellIntegration: HostShellIntegration | undefined;
  exitStatus: { code: number | undefined } | undefined;
  sent: { text: string; execute: boolean | undefined }[] = [];
  shown: (boolean | undefined)[] = [];
  disposed = false;
  executed: { executable: string; args: string[] }[] = [];
  execution = new FakeExecution();

  constructor(
    readonly name: string,
    readonly options: { cwd: string; env: Record<string, string> },
  ) {}

  attachIntegration(): HostShellIntegration {
    this.shellIntegration = {
      executeCommand: (executable, args) => {
        this.executed.push({ executable, args });
        return this.execution;
      },
    };
    return this.shellIntegration;
  }

  sendText(text: string, execute?: boolean): void {
    this.sent.push({ text, execute });
  }

  show(preserveFocus?: boolean): void {
    this.shown.push(preserveFocus);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** `vscode.window` falso: guarda os terminais e deixa o teste disparar os eventos. */
class FakeWindow implements TerminalWindowApi {
  terminals: FakeTerminal[] = [];
  integrationAtCreation = true;
  private integrationListeners: ((e: {
    terminal: HostTerminal;
    shellIntegration: HostShellIntegration;
  }) => void)[] = [];
  private endListeners: ((e: {
    terminal: HostTerminal;
    execution: HostExecution;
    exitCode: number | undefined;
  }) => void)[] = [];
  private closeListeners: ((t: HostTerminal) => void)[] = [];

  createTerminal(options: {
    name: string;
    cwd: string;
    env: Record<string, string>;
  }): FakeTerminal {
    const terminal = new FakeTerminal(options.name, options);
    if (this.integrationAtCreation) terminal.attachIntegration();
    this.terminals.push(terminal);
    return terminal;
  }

  onDidChangeTerminalShellIntegration(
    listener: (e: { terminal: HostTerminal; shellIntegration: HostShellIntegration }) => void,
  ): { dispose(): void } {
    this.integrationListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDidEndTerminalShellExecution(
    listener: (e: {
      terminal: HostTerminal;
      execution: HostExecution;
      exitCode: number | undefined;
    }) => void,
  ): { dispose(): void } {
    this.endListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDidCloseTerminal(listener: (t: HostTerminal) => void): { dispose(): void } {
    this.closeListeners.push(listener);
    return { dispose: () => undefined };
  }

  integrationReady(terminal: FakeTerminal): void {
    const shellIntegration = terminal.attachIntegration();
    for (const l of this.integrationListeners) l({ terminal, shellIntegration });
  }

  ended(terminal: FakeTerminal, exitCode: number | undefined): void {
    for (const l of this.endListeners) l({ terminal, execution: terminal.execution, exitCode });
  }

  closed(terminal: FakeTerminal): void {
    for (const l of this.closeListeners) l(terminal);
  }
}

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeClient(): {
  calls: Call[];
  request: (method: string, params?: unknown) => Promise<null>;
} {
  const calls: Call[] = [];
  return {
    calls,
    request: (method, params) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return Promise.resolve(null);
    },
  };
}

const spawn = {
  type: 'spawn' as const,
  sessionId: 'S-123456',
  nome: 'Aider',
  command: 'aider',
  args: ['--model', 'x y'],
  cwd: '/tmp/work',
  env: { A: '1' },
  prompt: '>\\s*$',
  silencioSegundos: 1,
};

async function drain(): Promise<void> {
  // Deixa os relatórios em fila e o consumo do fluxo andarem.
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

describe('hospedeiro dos agentes de terminal (terminal falso do VS Code)', () => {
  let api: FakeWindow;
  let client: ReturnType<typeof fakeClient>;
  let host: TerminalAgentHost;
  let now: number;

  const first = (): FakeTerminal => {
    const terminal = api.terminals[0];
    if (!terminal) throw new Error('nenhum terminal criado');
    return terminal;
  };
  const second = (): FakeTerminal => {
    const terminal = api.terminals[1];
    if (!terminal) throw new Error('segundo terminal não criado');
    return terminal;
  };
  const methods = (): string[] =>
    client.calls.map((c) => c.method.replace('agents.terminalHost.', ''));

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    api = new FakeWindow();
    client = fakeClient();
    host = new TerminalAgentHost(api, { now: () => now, tickMs: 100, flushMs: 50 });
    host.connected(client as never);
  });

  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
  };

  it('registra-se no Core dizendo que terminais ainda mantém', async () => {
    await drain();
    expect(client.calls[0]).toEqual({
      method: 'agents.terminalHost.register',
      params: { sessions: [] },
    });
    host.onCommand(spawn);
    host.connected(client as never);
    await drain();
    expect(client.calls.at(-1)?.params).toEqual({ sessions: ['S-123456'] });
  });

  it('cria o terminal na pasta do agente e roda o comando do perfil pela integração de shell', async () => {
    host.onCommand(spawn);
    await drain();
    const [terminal] = api.terminals;
    expect(terminal?.options).toMatchObject({ cwd: '/tmp/work', env: { A: '1' } });
    expect(terminal?.name).toContain('Aider');
    // Sem roubar o foco do usuário.
    expect(terminal?.shown).toEqual([true]);
    // Executável e argumentos separados; nenhum texto de shell montado.
    expect(terminal?.executed).toEqual([{ executable: 'aider', args: ['--model', 'x y'] }]);
    expect(terminal?.sent).toEqual([]);
    expect(methods()).toContain('ready');
  });

  it('espera a integração de shell quando ela ainda não existe', async () => {
    api.integrationAtCreation = false;
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    expect(terminal.executed).toEqual([]);
    api.integrationReady(terminal);
    expect(terminal.executed).toHaveLength(1);
    // Um segundo evento de integração não repete o comando.
    api.integrationReady(terminal);
    expect(terminal.executed).toHaveLength(1);
  });

  it('desiste com um motivo claro se a integração de shell nunca chega', async () => {
    api.integrationAtCreation = false;
    host = new TerminalAgentHost(api, { now: () => now, integrationTimeoutMs: 1_000 });
    host.connected(client as never);
    host.onCommand(spawn);
    await advance(1_100);
    const exit = client.calls.find((c) => c.method === 'agents.terminalHost.exit');
    expect(exit?.params.error).toMatch(/shell integration/);
  });

  it('transforma o fluxo em linhas limpas e informa ocioso/executando', async () => {
    host.onCommand(spawn);
    await drain();
    const exec = first().execution;
    exec.push('\u001b[32mpensando\u001b[0m\r\nresposta\r\n> ');
    await advance(60);
    const output = client.calls.find((c) => c.method === 'agents.terminalHost.output');
    expect(output?.params).toEqual({ sessionId: 'S-123456', text: 'pensando\nresposta' });

    // Silêncio com a linha de prompt: a CLI está ociosa e a linha do prompt sai.
    await advance(1_200);
    const states = client.calls.filter((c) => c.method === 'agents.terminalHost.state');
    expect(states.map((c) => c.params.state)).toEqual(['ocioso']);
    const last = client.calls.filter((c) => c.method === 'agents.terminalHost.output').at(-1);
    expect(last?.params.text).toBe('>');
  });

  it('envia o texto do Core como teclas (sendText), limpo, e marca como executando', async () => {
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    terminal.execution.push('pronto\n> ');
    await advance(10);
    await advance(1_200);
    client.calls.length = 0;

    host.onCommand({ type: 'input', sessionId: 'S-123456', text: 'rode\n\u001b[2Jos testes' });
    expect(terminal.sent).toEqual([{ text: 'rode os testes', execute: true }]);
    await drain();
    expect(client.calls.map((c) => [c.method, c.params.state])).toEqual([
      ['agents.terminalHost.state', 'executando'],
    ]);
  });

  it('ignora entrada para sessão desconhecida ou texto vazio', async () => {
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    host.onCommand({ type: 'input', sessionId: 'outra', text: 'x' });
    host.onCommand({ type: 'input', sessionId: 'S-123456', text: '\n\u001b[2J' });
    expect(terminal.sent).toEqual([]);
  });

  it('o fim do comando relata o código de saída e solta a última linha', async () => {
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    terminal.execution.push('adeus');
    await drain();
    api.ended(terminal, 2);
    await drain();
    const output = client.calls.find((c) => c.method === 'agents.terminalHost.output');
    expect(output?.params.text).toBe('adeus');
    const exit = client.calls.find((c) => c.method === 'agents.terminalHost.exit');
    expect(exit?.params).toEqual({ sessionId: 'S-123456', code: 2 });
    expect(host.has('S-123456')).toBe(false);
  });

  it('fechar o terminal conta como fim; o stop do Core fecha o terminal sem relatar', async () => {
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    api.closed(terminal);
    await drain();
    expect(methods()).toContain('exit');

    client.calls.length = 0;
    host.onCommand({ ...spawn, sessionId: 'S-654321' });
    await drain();
    const other = second();
    host.onCommand({ type: 'stop', sessionId: 'S-654321' });
    api.closed(other);
    await drain();
    expect(other.disposed).toBe(true);
    expect(methods()).not.toContain('exit');
  });

  it('Assumir: traz o terminal real para a frente, só enquanto a sessão vive', async () => {
    host.onCommand(spawn);
    await drain();
    const terminal = first();
    expect(host.show('S-123456')).toBe(true);
    expect(terminal.shown.at(-1)).toBeUndefined();
    expect(host.show('nao-existe')).toBe(false);
    api.ended(terminal, 0);
    expect(host.show('S-123456')).toBe(false);
  });

  it('não cria o mesmo terminal duas vezes', async () => {
    host.onCommand(spawn);
    host.onCommand(spawn);
    await drain();
    expect(api.terminals).toHaveLength(1);
  });
});
