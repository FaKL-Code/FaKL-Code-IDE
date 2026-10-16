import type { PedidoDeVoz } from '@fakl/voz';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enviarPedido,
  faltaParaEnviar,
  textoDoPedido,
  type ProgressoDeEnvio,
  tituloDoPedido,
  type EnvioDeVoz,
} from '../src/voz-envio.js';

function pedido(extra: Partial<PedidoDeVoz> = {}): PedidoDeVoz {
  return {
    intencao: 'tarefa',
    texto: 'arrumar o login',
    comecarAgora: true,
    reconhecido: [],
    confianca: 0.9,
    ...extra,
  };
}

function envio(extra: Partial<EnvioDeVoz> = {}): EnvioDeVoz {
  return {
    intencao: 'tarefa',
    texto: 'arrumar o login',
    pedido: pedido(),
    repoPath: 'D:/projetos/app',
    ...extra,
  };
}

/** Core de mentira: guarda as chamadas e responde por método (função: muda a cada chamada). */
function core(respostas: Record<string, unknown> = {}) {
  const chamadas: { method: string; params: unknown }[] = [];
  const call = vi.fn((method: string, params?: unknown) => {
    chamadas.push({ method, params });
    const resposta = respostas[method];
    return Promise.resolve(
      typeof resposta === 'function' ? (resposta as () => unknown)() : resposta,
    );
  }) as unknown as Parameters<typeof enviarPedido>[0];
  return { call, chamadas };
}

describe('tituloDoPedido', () => {
  it('usa a primeira linha e corta em 80 caracteres', () => {
    expect(tituloDoPedido('  arrumar   o login \nmais detalhes')).toBe('arrumar o login');
    const longo = tituloDoPedido('a'.repeat(200));
    expect(longo).toHaveLength(80);
    expect(longo.endsWith('…')).toBe(true);
  });
});

describe('textoDoPedido', () => {
  it('manda o texto interpretado, o mesmo que a confirmação mostra', () => {
    expect(
      textoDoPedido(pedido({ texto: 'corrigir o login' }), 'cria uma tarefa para corrigir o login'),
    ).toBe('corrigir o login');
  });

  it('sem texto interpretado, cai na fala', () => {
    expect(textoDoPedido(pedido({ texto: '  ' }), ' oi ')).toBe('oi');
  });
});

describe('faltaParaEnviar', () => {
  afterEach(() => useLocale('en'));

  it('fala pt-BR quando o idioma é pt-BR', () => {
    useLocale('pt-br');
    expect(faltaParaEnviar(envio({ texto: '  ' }))).toBe('Diga ou escreva o que você quer.');
    expect(faltaParaEnviar(envio({ repoPath: ' ' }))).toBe('Escolha a pasta ou o repositório.');
  });

  it('pede texto, pasta, agente e conversa conforme a intenção', () => {
    expect(faltaParaEnviar(envio({ texto: '  ' }))).toMatch(/Say or type/);
    expect(faltaParaEnviar(envio({ repoPath: ' ' }))).toMatch(/folder/);
    expect(faltaParaEnviar(envio({ intencao: 'avulsa' }))).toMatch(/agent/);
    expect(faltaParaEnviar(envio({ intencao: 'mensagem' }))).toMatch(/conversation/);
    expect(faltaParaEnviar(envio({ intencao: 'mensagem', sessionId: 's1', repoPath: '' }))).toBe(
      undefined,
    );
    expect(faltaParaEnviar(envio())).toBeUndefined();
  });
});

describe('enviarPedido', () => {
  it('tarefa: cria, começa e vai para a tarefa', async () => {
    const { call, chamadas } = core({ 'tasks.create': { id: 't1' }, 'runs.start': {} });
    const resultado = await enviarPedido(
      call,
      envio({
        perfilId: 'opus',
        pedido: pedido({ titulo: 'Login', criterio: ['pnpm test', 'pnpm lint'] }),
      }),
    );
    expect(chamadas).toEqual([
      {
        method: 'tasks.create',
        params: {
          titulo: 'Login',
          descricao: 'arrumar o login',
          repoPath: 'D:/projetos/app',
          origem: 'remoto',
          criterio: { comandos: ['pnpm test', 'pnpm lint'] },
          maestroProfileId: 'opus',
        },
      },
      { method: 'runs.start', params: { taskId: 't1' } },
    ]);
    expect(resultado).toMatchObject({ ok: true, destino: { name: 'tarefa', taskId: 't1' } });
  });

  it('tarefa sem começar agora não chama runs.start e sem título usa o texto', async () => {
    const { call, chamadas } = core({ 'tasks.create': { id: 't2' } });
    await enviarPedido(call, envio({ pedido: pedido({ comecarAgora: false }) }));
    expect(chamadas.map((c) => c.method)).toEqual(['tasks.create']);
    expect(chamadas[0]?.params).toMatchObject({ titulo: 'arrumar o login' });
    expect(chamadas[0]?.params).not.toHaveProperty('criterio');
    expect(chamadas[0]?.params).not.toHaveProperty('maestroProfileId');
  });

  it('tarefa que falha ao criar não começa nada', async () => {
    const { call, chamadas } = core();
    const resultado = await enviarPedido(call, envio());
    expect(resultado.ok).toBe(false);
    expect(chamadas).toHaveLength(1);
  });

  it('avulsa: inicia o agente num worktree e manda a mensagem', async () => {
    const { call, chamadas } = core({ 'agents.start': { sessionId: 's9' }, 'agents.send': {} });
    const resultado = await enviarPedido(
      call,
      envio({ intencao: 'avulsa', perfilId: 'sonnet', pedido: pedido({ intencao: 'avulsa' }) }),
    );
    expect(chamadas).toEqual([
      {
        method: 'agents.start',
        params: { profileId: 'sonnet', cwd: 'D:/projetos/app', worktree: true },
      },
      { method: 'agents.send', params: { sessionId: 's9', message: 'arrumar o login' } },
    ]);
    expect(resultado).toMatchObject({ ok: true, destino: { name: 'conversa', sessionId: 's9' } });
  });

  it('avulsa respeita worktree: false do pedido', async () => {
    const { call, chamadas } = core({ 'agents.start': { sessionId: 's9' } });
    await enviarPedido(
      call,
      envio({ intencao: 'avulsa', perfilId: 'x', pedido: pedido({ worktree: false }) }),
    );
    expect(chamadas[0]?.params).toMatchObject({ worktree: false });
  });

  it('mensagem: só manda para a conversa aberta', async () => {
    const { call, chamadas } = core({ 'agents.send': {} });
    const resultado = await enviarPedido(call, envio({ intencao: 'mensagem', sessionId: 's1' }));
    expect(chamadas).toEqual([
      { method: 'agents.send', params: { sessionId: 's1', message: 'arrumar o login' } },
    ]);
    expect(resultado).toMatchObject({ ok: true, destino: { name: 'conversa', sessionId: 's1' } });
  });

  it('não chama o Core quando falta algo', async () => {
    const { call, chamadas } = core();
    const resultado = await enviarPedido(call, envio({ repoPath: '' }));
    expect(resultado).toMatchObject({ ok: false });
    expect(chamadas).toHaveLength(0);
  });

  it('avulsa: se agents.send falha, devolve erro e a nova tentativa só reenvia', async () => {
    const progresso: ProgressoDeEnvio = {};
    let envios = 0;
    const { call, chamadas } = core({
      'agents.start': { sessionId: 's9' },
      'agents.send': () => (++envios > 1 ? {} : undefined),
    });
    const avulsa = envio({ intencao: 'avulsa', perfilId: 'x' });
    const primeira = await enviarPedido(call, avulsa, progresso);
    expect(primeira.ok).toBe(false);
    const segunda = await enviarPedido(call, avulsa, progresso);
    expect(segunda).toMatchObject({ ok: true, destino: { name: 'conversa', sessionId: 's9' } });
    expect(chamadas.map((c) => c.method)).toEqual(['agents.start', 'agents.send', 'agents.send']);
  });

  it('mensagem: se agents.send falha, não devolve ok', async () => {
    const { call } = core();
    const resultado = await enviarPedido(call, envio({ intencao: 'mensagem', sessionId: 's1' }));
    expect(resultado.ok).toBe(false);
  });

  it('tarefa: se runs.start falha, devolve erro e a nova tentativa não recria a tarefa', async () => {
    const progresso: ProgressoDeEnvio = {};
    let inicios = 0;
    const { call, chamadas } = core({
      'tasks.create': { id: 't7' },
      'runs.start': () => (++inicios > 1 ? {} : undefined),
    });
    const primeira = await enviarPedido(call, envio(), progresso);
    expect(primeira.ok).toBe(false);
    const segunda = await enviarPedido(call, envio(), progresso);
    expect(segunda).toMatchObject({ ok: true, destino: { name: 'tarefa', taskId: 't7' } });
    expect(chamadas.map((c) => c.method)).toEqual(['tasks.create', 'runs.start', 'runs.start']);
  });
});
