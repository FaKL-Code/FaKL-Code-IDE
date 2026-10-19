import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classificarComplexidade,
  compactarResultado,
  cortarMeio,
  DetectorDeRepeticao,
  Economia,
  escolherPerfil,
  juntarRepetidas,
  McpServer,
  rebaixou,
  Router,
  tirarAnsi,
  type CallContext,
  type EconomiaSomas,
  type ModoEconomia,
  type PerfilRoteavel,
} from '../src/index.js';

const context: CallContext = {
  connectionId: 'c',
  notify: () => undefined,
  onClose: () => undefined,
};

describe('compactação das respostas', () => {
  it('tira cores ANSI', () => {
    expect(tirarAnsi('\u001b[31mfalhou\u001b[0m ok')).toBe('falhou ok');
  });

  it('junta linhas repetidas a partir do mínimo e deixa as demais', () => {
    const texto = ['a', 'b', 'b', 'b', 'b', 'c', 'c', ''].join('\n');
    expect(juntarRepetidas(texto, 3)).toBe(
      ['a', 'b', '[linha acima repetida 4 vezes]', 'c', 'c', ''].join('\n'),
    );
  });

  it('corta o meio guardando começo e fim', () => {
    const texto = `${'a'.repeat(100)}${'z'.repeat(100)}`;
    const cortado = cortarMeio(texto, 50);
    expect(cortado.startsWith('a'.repeat(30))).toBe(true);
    expect(cortado.endsWith('z'.repeat(20))).toBe(true);
    expect(cortado).toContain('150 caracteres omitidos');
    expect(cortarMeio('curto', 50)).toBe('curto');
  });

  it('desligado devolve o JSON indentado de sempre, sem economia', () => {
    const r = compactarResultado({ a: 1, b: [1, 2] }, 'desligado');
    expect(r.texto).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    expect(r.economizados).toBe(0);
  });

  it('equilibrado tira a indentação e mede a diferença', () => {
    const valor = {
      itens: [
        { id: 1, nome: 'x' },
        { id: 2, nome: 'y' },
      ],
      ok: true,
    };
    const r = compactarResultado(valor, 'equilibrado');
    expect(r.texto).toBe(JSON.stringify(valor));
    expect(r.economizados).toBe(JSON.stringify(valor, null, 2).length - r.texto.length);
    expect(r.economizados).toBeGreaterThan(20);
  });

  it('equilibrado corta texto enorme e agressivo poda vazios', () => {
    const log = Array.from({ length: 3000 }, (_, i) => `linha ${String(i)}`).join('\n');
    const r = compactarResultado({ log }, 'equilibrado');
    expect(r.texto.length).toBeLessThan(14_000);
    expect(r.texto).toContain('omitidos');
    const podado = compactarResultado({ a: null, b: '', c: [], d: 0, e: 'x' }, 'agressivo');
    expect(JSON.parse(podado.texto)).toEqual({ d: 0, e: 'x' });
    const mantido = compactarResultado({ a: null }, 'equilibrado');
    expect(JSON.parse(mantido.texto)).toEqual({ a: null });
  });
});

describe('repetição de leituras', () => {
  const grande = 'x'.repeat(2000);
  let agora = 1_000_000;
  const detector = (modo: ModoEconomia) =>
    new DetectorDeRepeticao(
      () => modo,
      () => agora,
    );

  beforeEach(() => {
    agora = 1_000_000;
  });

  it('avisa quando a mesma leitura se repete dentro do prazo', () => {
    const d = detector('equilibrado');
    expect(d.repetida('vault.read', { path: 'a' })).toBeUndefined();
    d.lembrar('vault.read', { path: 'a' }, grande);
    agora += 12_000;
    const r = d.repetida('vault.read', { path: 'a' });
    expect(r?.aviso).toContain('há 12s');
    expect(r?.economizados).toBeGreaterThan(1500);
    expect(d.repetida('vault.read', { path: 'b' })).toBeUndefined();
  });

  it('não avisa depois do prazo nem com a economia desligada', () => {
    const d = detector('equilibrado');
    d.lembrar('vault.read', { path: 'a' }, grande);
    agora += 46_000;
    expect(d.repetida('vault.read', { path: 'a' })).toBeUndefined();
    const off = detector('desligado');
    off.lembrar('vault.read', { path: 'a' }, grande);
    expect(off.repetida('vault.read', { path: 'a' })).toBeUndefined();
  });

  it('uma escrita ou comando limpa o que foi lembrado', () => {
    const d = detector('equilibrado');
    d.lembrar('vault.read', { path: 'a' }, grande);
    expect(d.repetida('vault.write', { path: 'a' })).toBeUndefined();
    expect(d.repetida('vault.read', { path: 'a' })).toBeUndefined();
  });

  it('não lembra respostas pequenas nem de ferramentas que não são leitura', () => {
    const d = detector('equilibrado');
    d.lembrar('vault.read', { path: 'a' }, 'curto');
    d.lembrar('ssh.exec', { cmd: 'ls' }, grande);
    expect(d.repetida('vault.read', { path: 'a' })).toBeUndefined();
    expect(d.repetida('ssh.exec', { cmd: 'ls' })).toBeUndefined();
  });
});

describe('roteador por camadas', () => {
  it('classifica por sinais do texto', () => {
    expect(classificarComplexidade('corrigir typo no README').nivel).toBe('baixa');
    expect(
      classificarComplexidade('Refatorar a autenticação e migrar o schema do banco de dados').nivel,
    ).toBe('alta');
    expect(
      classificarComplexidade(
        'Implementar o endpoint de listagem de pedidos com paginação e testes. '.repeat(5),
      ).nivel,
    ).toBe('media');
    expect(classificarComplexidade('renomear variável', { papel: 'maestro' }).nivel).not.toBe(
      'baixa',
    );
  });

  const perfil = (
    id: string,
    custoRelativo: PerfilRoteavel['custoRelativo'],
    extra: Partial<PerfilRoteavel> = {},
  ): PerfilRoteavel => ({
    id,
    custoRelativo,
    instalado: true,
    bloqueado: false,
    podeSerMaestro: false,
    ...extra,
  });

  const perfis = [perfil('haiku', 'baixo'), perfil('sonnet', 'médio'), perfil('opus', 'alto')];

  it('escolhe a camada do nível', () => {
    expect(escolherPerfil(perfis, 'baixa')?.id).toBe('haiku');
    expect(escolherPerfil(perfis, 'media')?.id).toBe('sonnet');
    expect(escolherPerfil(perfis, 'alta')?.id).toBe('opus');
  });

  it('cai para a camada vizinha quando a ideal não está disponível', () => {
    const sem = [perfil('haiku', 'baixo', { instalado: false }), perfil('sonnet', 'médio')];
    const escolha = escolherPerfil(sem, 'baixa');
    expect(escolha?.id).toBe('sonnet');
    expect(escolha?.motivo).toContain('ideal não tem perfil');
    expect(escolherPerfil([perfil('a', 'baixo', { bloqueado: true })], 'baixa')).toBeUndefined();
  });

  it('o placar tira quem vem sendo reprovado e desempata por aprovação', () => {
    const lista = [
      perfil('ruim', 'baixo', { taxaAprovacao: 0.3 }),
      perfil('bom', 'baixo', { taxaAprovacao: 0.9 }),
      perfil('medio', 'baixo', { taxaAprovacao: 0.7 }),
    ];
    expect(escolherPerfil(lista, 'baixa')?.id).toBe('bom');
    expect(escolherPerfil(lista.slice(0, 1), 'baixa')?.id).toBe('ruim');
  });

  it('sub-maestro só vai a quem pode ser maestro', () => {
    const lista = [perfil('a', 'baixo'), perfil('b', 'médio', { podeSerMaestro: true })];
    expect(escolherPerfil(lista, 'baixa', { papel: 'maestro' })?.id).toBe('b');
  });

  it('diz se a escolha ficou mais barata que o perfil de quem pediu', () => {
    const escolha = escolherPerfil(perfis, 'baixa');
    expect(escolha && rebaixou(escolha, 'alto')).toBe(true);
    expect(escolha && rebaixou(escolha, 'baixo')).toBe(false);
  });
});

describe('livro-caixa', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-economia-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nova = (modo: { atual: ModoEconomia }) =>
    new Economia({
      modo: () => modo.atual,
      setModo: (m) => {
        modo.atual = m;
        return Promise.resolve();
      },
      dataDir: dir,
    });

  it('soma, estima tokens, grava e relê', async () => {
    const modo = { atual: 'equilibrado' as ModoEconomia };
    const e = nova(modo);
    e.registrar({
      respostas: 2,
      caracteresCompactados: 4000,
      repeticoes: 1,
      caracteresRepeticoes: 400,
    });
    const status = e.status();
    expect(status.total.tokensEstimados).toBe(1100);
    expect(status.hoje.respostas).toBe(2);
    await e.flush();
    const gravado = JSON.parse(await readFile(join(dir, 'economia.json'), 'utf8')) as {
      total: { respostas: number };
    };
    expect(gravado.total.respostas).toBe(2);
    const outra = nova(modo);
    await outra.load();
    expect(outra.status().total.caracteresCompactados).toBe(4000);
    await e.reset();
    expect(e.status().total.respostas).toBe(0);
  });

  it('atende status, setModo e registrar pelo roteador, rejeitando valores ruins', async () => {
    const modo = { atual: 'equilibrado' as ModoEconomia };
    const e = nova(modo);
    const router = new Router();
    e.register(router);
    await router.dispatch(
      'economia.registrar',
      { caracteresCompactados: 800, respostas: -5, x: 1 },
      context,
    );
    expect(e.status().total.caracteresCompactados).toBe(800);
    expect(e.status().total.respostas).toBe(0);
    const trocado = (await router.dispatch('economia.setModo', { modo: 'agressivo' }, context)) as {
      modo: string;
    };
    expect(trocado.modo).toBe('agressivo');
    await expect(
      router.dispatch('economia.setModo', { modo: 'maximo' }, context),
    ).rejects.toThrow();
  });
});

describe('servidor MCP com economia', () => {
  const ferramenta = {
    name: 'ler',
    description: 'lê',
    method: 'vault.read' as const,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };

  function montar(modo: ModoEconomia, resposta: unknown) {
    const saidas: string[] = [];
    const registros: EconomiaSomas[] = [];
    const chamadas = vi.fn(() => Promise.resolve(resposta));
    const server = new McpServer({
      name: 't',
      version: '0',
      tools: [ferramenta],
      call: chamadas,
      write: (linha) => saidas.push(linha),
      modo: () => modo,
      registrar: (somas) => registros.push(somas),
    });
    const chamar = async (id: number) => {
      await server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'ler', arguments: { path: 'a' } },
        }),
      );
      const ultima = JSON.parse(saidas[saidas.length - 1] ?? '{}') as {
        result: { content: { text: string }[] };
      };
      return ultima.result.content[0]?.text ?? '';
    };
    return { chamar, chamadas, registros };
  }

  it('desligado responde como sempre (JSON indentado)', async () => {
    const { chamar } = montar('desligado', { a: 1 });
    expect(await chamar(1)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('equilibrado responde compacto e a segunda leitura igual vira aviso, sem chamar o Core', async () => {
    vi.useFakeTimers();
    try {
      const corpo = { texto: 'y'.repeat(3000), itens: [1, 2, 3] };
      const { chamar, chamadas, registros } = montar('equilibrado', corpo);
      expect(await chamar(1)).toBe(JSON.stringify(corpo));
      const segunda = await chamar(2);
      expect(segunda).toContain('Resultado idêntico');
      expect(chamadas).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(registros).toHaveLength(1);
      expect(registros[0]?.repeticoes).toBe(1);
      expect(registros[0]?.respostas).toBe(1);
      expect(registros[0]?.caracteresRepeticoes).toBeGreaterThan(2500);
    } finally {
      vi.useRealTimers();
    }
  });
});
