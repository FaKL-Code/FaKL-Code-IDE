import {
  FaklErrorCode,
  type AgentTerminalAttachResult,
  type AgentTerminalLinesParams,
} from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  AgentTerminals,
  EventBus,
  Router,
  sanitizeTerminalText,
  type CallContext,
} from '../src/index.js';
import { redactSecrets } from '../src/security/scan.js';

const SEGREDO = 'segredo-super-longo-12345';

function conexao(id: string): CallContext & {
  recebidas: AgentTerminalLinesParams[];
  fechar(): void;
} {
  const recebidas: AgentTerminalLinesParams[] = [];
  const limpezas: (() => void)[] = [];
  return {
    connectionId: id,
    recebidas,
    notify: (_method, params) => {
      recebidas.push(params as AgentTerminalLinesParams);
    },
    onClose: (fn) => limpezas.push(fn),
    fechar: () => {
      for (const fn of limpezas) fn();
    },
  };
}

function montar(capacity?: number) {
  const bus = new EventBus();
  const terminals = new AgentTerminals(bus, {
    redact: (text) => redactSecrets(text, [SEGREDO]),
    exists: (id) => id !== 'nada',
    ...(capacity ? { capacity } : {}),
  });
  const router = new Router();
  terminals.register(router);
  const saida = (id: string, text: string, kind = 'message') =>
    bus.publish('agent.output', id, { kind, text });
  const limpo = (id: string) =>
    // eslint-disable-next-line no-control-regex
    terminals.lines(id).map((l) => l.text.replace(/\u001b\[\d+m/g, ''));
  const attach = (id: string, conn: CallContext) =>
    router.dispatch(
      'agents.terminal.attach',
      { sessionId: id },
      conn,
    ) as Promise<AgentTerminalAttachResult>;
  return { bus, terminals, router, saida, limpo, attach };
}

describe('terminal de leitura dos agentes', () => {
  it('monta linhas na ordem dos eventos e junta pedaços de saída', () => {
    const { bus, saida, limpo } = montar();
    bus.publish('agent.state', 's1', { state: 'executando', previous: 'preparando' });
    saida('s1', 'Olá, mun');
    saida('s1', 'do\nsegunda ');
    saida('s1', 'linha\n');
    bus.publish('agent.tool', 's1', { toolCallId: 't1', title: 'Read a.ts', status: 'pending' });
    bus.publish('agent.tool', 's1', { toolCallId: 't1', title: 'Read a.ts', status: 'pending' });
    bus.publish('agent.tool', 's1', { toolCallId: 't1', title: 'Read a.ts', status: 'completed' });
    expect(limpo('s1')).toEqual([
      'Estado: preparando -> executando',
      'Olá, mundo',
      'segunda linha',
      'Ferramenta: Read a.ts (pending)',
      'Ferramenta: Read a.ts (completed)',
    ]);
  });

  it('mostra o que ficou sem quebra de linha quando outro evento chega', () => {
    const { bus, saida, limpo } = montar();
    saida('s1', 'sem fim');
    bus.publish('agent.state', 's1', { state: 'ocioso', previous: 'executando' });
    expect(limpo('s1')).toEqual(['sem fim', 'Estado: executando -> ocioso']);
  });

  it('registra pedidos de permissão, detalhes e a decisão', () => {
    const { bus, limpo } = montar();
    bus.publish('agent.permission', 's1', {
      id: 'p1',
      title: 'Run npm test',
      detail: 'command: npm test\n\ncwd: /work',
      options: [],
    });
    bus.publish('agent.answer', 's1', { id: 'p1', allow: true });
    bus.publish('agent.permission', 's1', { id: 'p2', title: 'Delete', options: [] });
    bus.publish('agent.answer', 's1', { id: 'p2', allow: false });
    expect(limpo('s1')).toEqual([
      'Permissão pedida: Run npm test',
      '  command: npm test',
      '  cwd: /work',
      'Permissão concedida: Run npm test',
      'Permissão pedida: Delete',
      'Permissão negada: Delete',
    ]);
  });

  it('pinta pensamento, erro e estado com cores ANSI simples', () => {
    const { saida, terminals, bus } = montar();
    saida('s1', 'pensando\n', 'thought');
    saida('s1', 'quebrou\n', 'error');
    bus.publish('agent.state', 's1', { state: 'falhou', previous: 'executando', reason: 'boom' });
    const [a, b, c] = terminals.lines('s1').map((l) => l.text);
    expect(a).toBe('\u001b[90mpensando\u001b[0m');
    expect(b).toBe('\u001b[31mquebrou\u001b[0m');
    expect(c).toContain('Estado: executando -> falhou (boom)');
  });

  it('tira segredos, inclusive os cortados entre dois pedaços', () => {
    const { saida, terminals, bus } = montar();
    saida('s1', `a chave é ${SEGREDO.slice(0, 10)}`);
    saida('s1', `${SEGREDO.slice(10)} fim\n`);
    bus.publish('agent.permission', 's1', {
      id: 'p',
      title: `usa ${SEGREDO}`,
      detail: `token=${SEGREDO}`,
      options: [],
    });
    const texto = terminals
      .lines('s1')
      .map((l) => l.text)
      .join('\n');
    expect(texto).not.toContain(SEGREDO);
    expect(texto).not.toContain(SEGREDO.slice(0, 10));
    expect(texto).toContain('segredo removido');
  });

  it('neutraliza escapes que o agente mande', () => {
    expect(sanitizeTerminalText('a\u001b[2Jb\u0007c\r\nd\re')).toBe('a[2Jbc\nd\ne');
    const { saida, terminals } = montar();
    saida('s1', '\u001b]0;titulo\u0007oi\n');
    expect(terminals.lines('s1')[0]?.text).toBe(']0;titulooi');
  });

  it('guarda só as últimas linhas do buffer circular, com seq contínuo', async () => {
    const { saida, terminals, attach } = montar(5);
    for (let i = 1; i <= 8; i++) saida('s1', `linha ${i}\n`);
    const result = await attach('s1', conexao('c1'));
    expect(result.lines.map((l) => l.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(result.lines.map((l) => l.text)).toEqual([
      'linha 4',
      'linha 5',
      'linha 6',
      'linha 7',
      'linha 8',
    ]);
    expect(result.dropped).toBe(3);
    expect(terminals.lines('s1')).toHaveLength(5);
  });

  it('entrega o histórico no attach e as linhas novas até o detach', async () => {
    const { router, saida, attach } = montar();
    saida('s1', 'antes\n');
    const conn = conexao('c1');
    const result = await attach('s1', conn);
    expect(result.lines.map((l) => l.text)).toEqual(['antes']);
    expect(result.state).toBe('preparando');
    saida('s1', 'depois\n');
    expect(conn.recebidas).toHaveLength(1);
    expect(conn.recebidas[0]?.lines.map((l) => l.text)).toEqual(['depois']);
    expect(conn.recebidas[0]?.lines[0]?.seq).toBe(2);
    await router.dispatch('agents.terminal.detach', { sessionId: 's1' }, conn);
    saida('s1', 'ignorada\n');
    expect(conn.recebidas).toHaveLength(1);
  });

  it('atende vários clientes e para de avisar quem desconecta', async () => {
    const { saida, attach } = montar();
    const a = conexao('a');
    const b = conexao('b');
    await attach('s1', a);
    await attach('s1', b);
    // Anexar de novo não duplica a entrega.
    await attach('s1', b);
    saida('s1', 'um\n');
    expect(a.recebidas).toHaveLength(1);
    expect(b.recebidas).toHaveLength(1);
    a.fechar();
    saida('s1', 'dois\n');
    expect(a.recebidas).toHaveLength(1);
    expect(b.recebidas).toHaveLength(2);
    // Cada sessão tem o seu buffer.
    saida('s2', 'outra\n');
    expect(b.recebidas).toHaveLength(2);
  });

  it('mantém o histórico de sessão encerrada e informa o estado final', async () => {
    const { saida, bus, attach } = montar();
    saida('s1', 'fim do trabalho\n');
    bus.publish('agent.state', 's1', { state: 'concluído', previous: 'executando' });
    const result = await attach('s1', conexao('c'));
    expect(result.state).toBe('concluído');
    expect(result.lines).toHaveLength(2);
  });

  it('recusa sessão que não existe e aceita a que existe sem eventos', async () => {
    const { terminals, attach } = montar();
    await expect(attach('nada', conexao('c'))).rejects.toMatchObject({
      code: FaklErrorCode.NotFound,
    });
    const result = await attach('vazia', conexao('c'));
    expect(result.lines).toEqual([]);
    terminals.forget('vazia');
    expect(terminals.lines('vazia')).toEqual([]);
  });

  it('quebra linha enorme sem quebra e limita o detalhe de permissão', () => {
    const { saida, terminals, bus } = montar();
    saida('s1', 'x'.repeat(4_500));
    saida('s1', '\n');
    expect(terminals.lines('s1').map((l) => l.text.length)).toEqual([2_000, 2_000, 500]);
    bus.publish('agent.permission', 's2', {
      id: 'p',
      title: 't',
      detail: Array.from({ length: 20 }, (_, i) => `arg ${i}`).join('\n'),
      options: [],
    });
    expect(terminals.lines('s2')).toHaveLength(1 + 8 + 1);
  });
});
