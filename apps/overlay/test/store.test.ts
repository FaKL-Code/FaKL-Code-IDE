import type { AgentPermissionRequest, AgentSessionInfo, FaklEvent } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import type { OverlayBridge, OverlayStatus } from '../src/bridge.js';
import { Overlay } from '../src/store.js';

type Answer = (params: unknown) => unknown;

/** Ponte de teste: o Core é um mapa de métodos; quem não está nele responde `null`. */
class ScriptedBridge implements OverlayBridge {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly answers = new Map<string, Answer>();
  private frame: (frame: string) => void = () => undefined;
  private status: (status: OverlayStatus) => void = () => undefined;

  send(frame: string): void {
    const { id, method, params } = JSON.parse(frame) as {
      id: number;
      method: string;
      params?: unknown;
    };
    this.calls.push({ method, params });
    setTimeout(() => {
      try {
        const answer = this.answers.get(method);
        const result = method === 'events.subscribe' ? { subscriptionId: 'x' } : answer?.(params);
        this.frame(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null }));
      } catch (error) {
        this.frame(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : 'erro' },
          }),
        );
      }
    }, 0);
  }

  onFrame(listener: (frame: string) => void): void {
    this.frame = listener;
  }

  onStatus(listener: (status: OverlayStatus) => void): void {
    this.status = listener;
  }

  setMode(): void {
    // O modo não importa aqui.
  }

  hide(): void {
    // Nem esconder.
  }

  quit(): void {
    // Nem sair.
  }

  onSide(): void {
    // O lado do balão também não.
  }

  setClickThrough(): void {
    // Nem os cliques que atravessam a janela.
  }

  setQuiet(): void {
    // O não perturbe tem teste próprio (quiet.test.ts).
  }

  onQuiet(): void {
    // Idem.
  }

  onCommand(): void {
    // O principal não manda comandos nestes testes.
  }

  setStatus(status: OverlayStatus): void {
    this.status(status);
  }

  event(topic: string, subject: string, data: unknown): void {
    const event = { id: String(Math.random()), topic, subject, ts: '', data } as FaklEvent;
    this.frame(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'events.event',
        params: { subscriptionId: 'x', event },
      }),
    );
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  last(method: string): unknown {
    return this.calls.findLast((c) => c.method === method)?.params;
  }
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function online(): Promise<{ bridge: ScriptedBridge; overlay: Overlay }> {
  const bridge = new ScriptedBridge();
  const overlay = new Overlay(bridge);
  bridge.setStatus('online');
  await tick(20);
  expect(overlay.connection).toBe('online');
  return { bridge, overlay };
}

const agent = (
  sessionId: string,
  state: AgentSessionInfo['state'],
  extra: Partial<AgentSessionInfo> = {},
): AgentSessionInfo => ({
  sessionId,
  profileId: 'claude',
  nome: `Agente ${sessionId}`,
  cwd: '/repo',
  state,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  permissoes: 'perguntar',
  opcoes: [],
  ...extra,
});

const START = { profileId: 'claude', cwd: '/repo', worktree: true } as const;

describe('Overlay: conversa nova', () => {
  it('quando o envio falha, a nova tentativa manda na mesma sessão, sem abrir outra', async () => {
    const { bridge, overlay } = await online();
    let sessions = 0;
    let failSend = true;
    bridge.answers.set('agents.start', () => ({ sessionId: `s${String(++sessions)}` }));
    bridge.answers.set('agents.send', () => {
      if (failSend) throw new Error('o agente não respondeu');
      return null;
    });
    const errors: string[] = [];
    overlay.onNotice((text, tone) => {
      if (tone === 'erro') errors.push(text);
    });

    // Falhou: sem id (o rascunho fica com quem chamou) e o erro foi avisado.
    expect(await overlay.startConversation(START, 'corrige o bug')).toBeUndefined();
    expect(errors).toEqual(['o agente não respondeu']);
    expect(bridge.count('agents.start')).toBe(1);

    failSend = false;
    expect(await overlay.startConversation(START, 'corrige o bug')).toBe('s1');
    expect(bridge.count('agents.start')).toBe(1);
    expect(bridge.count('agents.send')).toBe(2);
    expect(bridge.last('agents.send')).toEqual({ sessionId: 's1', message: 'corrige o bug' });

    // Concluída: o que sobrou não vale para a próxima conversa.
    expect(await overlay.startConversation(START, 'outra')).toBe('s2');
    expect(bridge.count('agents.start')).toBe(2);
  });

  it('com outra pasta, a nova tentativa abre uma sessão nova', async () => {
    const { bridge, overlay } = await online();
    let sessions = 0;
    let failSend = true;
    bridge.answers.set('agents.start', () => ({ sessionId: `s${String(++sessions)}` }));
    bridge.answers.set('agents.send', () => {
      if (failSend) throw new Error('falhou');
      return null;
    });
    await overlay.startConversation(START, 'oi');
    failSend = false;
    expect(await overlay.startConversation({ ...START, cwd: '/outra' }, 'oi')).toBe('s2');
    expect(bridge.count('agents.start')).toBe(2);
  });

  it('falha ao abrir a sessão: nada guardado, nada enviado', async () => {
    const { bridge, overlay } = await online();
    bridge.answers.set('agents.start', () => {
      throw new Error('pasta inválida');
    });
    expect(await overlay.startConversation(START, 'oi')).toBeUndefined();
    expect(bridge.count('agents.send')).toBe(0);
    expect(overlay.isStarting).toBe(false);
  });

  it('dois pedidos juntos (Ctrl+Enter duplo) criam uma sessão só', async () => {
    const { bridge, overlay } = await online();
    let sessions = 0;
    bridge.answers.set('agents.start', () => ({ sessionId: `s${String(++sessions)}` }));
    const first = overlay.startConversation(START, 'oi');
    expect(overlay.isStarting).toBe(true);
    const second = overlay.startConversation(START, 'oi');
    expect(await second).toBeUndefined();
    expect(await first).toBe('s1');
    expect(bridge.count('agents.start')).toBe(1);
    expect(bridge.count('agents.send')).toBe(1);
    // A trava é liberada no fim, também depois de sucesso.
    expect(overlay.isStarting).toBe(false);
    expect(await overlay.startConversation(START, 'de novo')).toBe('s2');
  });
});

describe('Overlay: compositor da conversa', () => {
  it('um envio por vez por conversa, e a trava solta mesmo com erro', async () => {
    const { bridge, overlay } = await online();
    let fail = false;
    bridge.answers.set('agents.send', () => {
      if (fail) throw new Error('caiu');
      return null;
    });
    const first = overlay.compose('s1', 'oi');
    expect(overlay.isSending('s1')).toBe(true);
    // Enter repetido enquanto o primeiro não voltou: ignorado.
    expect(await overlay.compose('s1', 'oi')).toBe(false);
    // Outra conversa não é afetada.
    expect(await overlay.compose('s2', 'oi')).toBe(true);
    expect(await first).toBe(true);
    expect(bridge.count('agents.send')).toBe(2);

    fail = true;
    expect(await overlay.compose('s1', 'mais uma')).toBe(false);
    expect(overlay.isSending('s1')).toBe(false);
    fail = false;
    expect(await overlay.compose('s1', 'mais uma')).toBe(true);
  });
});

describe('Overlay: permissão', () => {
  const request: AgentPermissionRequest = {
    sessionId: 's1',
    id: 'p1',
    title: 'Editar a.txt',
    options: [
      { id: 'sim', name: 'Permitir', kind: 'allow_once' },
      { id: 'sempre', name: 'Permitir sempre', kind: 'allow_always' },
    ],
  };

  it('leva "sempre" ao Core só ao permitir; sem ele, o corpo é o de antes', async () => {
    const { bridge, overlay } = await online();
    overlay.permissions = [request];
    await overlay.answerPermission(request, true, true);
    expect(bridge.last('agents.permission')).toEqual({
      sessionId: 's1',
      id: 'p1',
      allow: true,
      sempre: true,
    });
    expect(overlay.permissions).toEqual([]);

    await overlay.answerPermission(request, true);
    expect(bridge.last('agents.permission')).toEqual({ sessionId: 's1', id: 'p1', allow: true });

    // Negar "sempre" não existe: o campo nem vai.
    await overlay.answerPermission(request, false, true);
    expect(bridge.last('agents.permission')).toEqual({ sessionId: 's1', id: 'p1', allow: false });
  });
});

describe('Overlay: limites e janelas do Core', () => {
  it('reconstrói o limite de antes de o overlay abrir a partir de agents.list', async () => {
    const { bridge, overlay } = await online();
    bridge.answers.set('agents.list', () => [
      agent('s1', 'ocioso', {
        limite: { motivo: 'Claude AI usage limit reached', em: '2026-10-15T10:00:00.000Z' },
      }),
      // Encerrado: não é card, mesmo com aviso guardado.
      agent('s2', 'falhou', { limite: { motivo: 'weekly limit', em: '2026-10-15T09:00:00.000Z' } }),
      agent('s3', 'ocioso'),
    ]);
    await overlay.refreshAgents();
    expect([...overlay.snapshot().limited]).toEqual(['s1']);
    expect(overlay.limitReason('s1')).toBe('Claude AI usage limit reached');

    // Volta a trabalhar: o evento tira o card, e a lista seguinte (sem `limite`) não o traz de volta.
    bridge.event('agent.state', 's1', { state: 'pensando', previous: 'ocioso' });
    await tick();
    bridge.answers.set('agents.list', () => [agent('s1', 'pensando'), agent('s3', 'ocioso')]);
    await overlay.refreshAgents();
    expect(overlay.snapshot().limited.size).toBe(0);
  });

  it('lê as janelas dos planos do Core e mantém as últimas se a leitura falhar', async () => {
    const { bridge, overlay } = await online();
    const janelas = [
      {
        provedor: 'openai',
        sessao: { fracao: 0.4, resetaEm: 1_800_000_000_000 },
        origem: 'real',
      },
    ];
    bridge.answers.set('usage.windows', () => ({ janelas }));
    await overlay.refreshWindows();
    expect(overlay.windows).toEqual(janelas);

    bridge.answers.set('usage.windows', () => {
      throw new Error('Core antigo');
    });
    await overlay.refreshWindows();
    expect(overlay.windows).toEqual(janelas);
  });
});
