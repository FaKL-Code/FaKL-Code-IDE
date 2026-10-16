import { useLocale } from '@fakl/i18n';
import type { PedidoDeVoz } from '@fakl/voz';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acaoDoPedido,
  bytesParaBase64,
  intencoesPossiveis,
  modosDeVoz,
  nomeDoModo,
  perfisDeVoz,
  problemaNoEndpoint,
  reposDeVoz,
  ROTULOS_DE_INTENCAO,
  rotuloDaIntencao,
  tituloDaTarefa,
  vozNaIde,
} from '../src/voz-model.js';

function pedido(parcial: Partial<PedidoDeVoz>): PedidoDeVoz {
  return {
    intencao: 'avulsa',
    texto: 'corrigir o bug do login',
    comecarAgora: true,
    reconhecido: [],
    confianca: 0.9,
    ...parcial,
  };
}

describe('acaoDoPedido', () => {
  it('tarefa vira tasks.create com repositório, maestro e critério', () => {
    const acao = acaoDoPedido(
      pedido({
        intencao: 'tarefa',
        titulo: 'Corrigir o login',
        perfilId: 'opus',
        repoPath: '/repos/app',
        criterio: ['pnpm test', '  ', 'pnpm lint'],
        comecarAgora: false,
      }),
      { repoPadrao: '/repos/outro' },
    );
    expect(acao).toEqual({
      tipo: 'tarefa',
      tarefa: {
        titulo: 'Corrigir o login',
        descricao: 'corrigir o bug do login',
        origem: 'manual',
        repoPath: '/repos/app',
        permissoes: 'perguntar',
        maestroProfileId: 'opus',
        criterio: { comandos: ['pnpm test', 'pnpm lint'] },
      },
      comecar: false,
    });
  });

  it('tarefa sem repositório citado usa a pasta aberta e tira o título do texto', () => {
    const acao = acaoDoPedido(pedido({ intencao: 'tarefa' }), { repoPadrao: '/repos/app' });
    expect(acao).toEqual({
      tipo: 'tarefa',
      tarefa: {
        titulo: 'corrigir o bug do login',
        descricao: 'corrigir o bug do login',
        origem: 'manual',
        repoPath: '/repos/app',
        permissoes: 'perguntar',
      },
      comecar: true,
    });
  });

  it('tarefa sem pasta nenhuma pede para abrir o repositório', () => {
    const acao = acaoDoPedido(pedido({ intencao: 'tarefa' }), {});
    expect(acao).toEqual({
      tipo: 'erro',
      mensagem: 'Open the repository folder (local, with git) for the maestro to work in.',
    });
  });

  it('avulsa usa o perfil citado, senão o padrão, e o worktree pedido', () => {
    expect(
      acaoDoPedido(pedido({ perfilId: 'codex', worktree: true }), { perfilPadrao: 'claude' }),
    ).toEqual({
      tipo: 'avulsa',
      profileId: 'codex',
      texto: 'corrigir o bug do login',
      worktree: true,
    });
    expect(acaoDoPedido(pedido({}), { perfilPadrao: 'claude' })).toEqual({
      tipo: 'avulsa',
      profileId: 'claude',
      texto: 'corrigir o bug do login',
      worktree: false,
    });
    expect(acaoDoPedido(pedido({}), {}).tipo).toBe('erro');
  });

  it('avulsa preserva a pasta citada na fala', () => {
    expect(
      acaoDoPedido(pedido({ repoPath: 'D:/projetos/outro' }), { perfilPadrao: 'claude' }),
    ).toEqual({
      tipo: 'avulsa',
      profileId: 'claude',
      texto: 'corrigir o bug do login',
      worktree: false,
      repoPath: 'D:/projetos/outro',
    });
  });

  it('mensagem vai para a conversa ativa; sem ela, erro', () => {
    expect(acaoDoPedido(pedido({ intencao: 'mensagem' }), { sessaoAtiva: 's1' })).toEqual({
      tipo: 'mensagem',
      sessionId: 's1',
      texto: 'corrigir o bug do login',
    });
    expect(acaoDoPedido(pedido({ intencao: 'mensagem' }), {}).tipo).toBe('erro');
  });

  it('pedido vazio não executa nada', () => {
    expect(acaoDoPedido(pedido({ texto: '   ' }), { perfilPadrao: 'claude' }).tipo).toBe('erro');
  });
});

describe('tituloDaTarefa', () => {
  it('usa a primeira linha e corta em 80 caracteres', () => {
    expect(tituloDaTarefa('  primeira\nsegunda')).toBe('primeira');
    const longo = 'a'.repeat(100);
    const titulo = tituloDaTarefa(longo);
    expect(titulo).toHaveLength(80);
    expect(titulo.endsWith('...')).toBe(true);
  });
});

describe('contexto da voz', () => {
  it('mensagem só aparece com conversa aberta', () => {
    expect(intencoesPossiveis(false)).toEqual(['tarefa', 'avulsa']);
    expect(intencoesPossiveis(true)).toEqual(['tarefa', 'avulsa', 'mensagem']);
  });

  it('perfis levam o modelo ou, sem ele, o provedor', () => {
    expect(
      perfisDeVoz([
        { id: 'opus', nome: 'Claude Opus', modelo: 'claude-opus-5-5', provedor: 'anthropic' },
        { id: 'codex', nome: 'Codex', provedor: 'openai' },
        { id: 'x', nome: 'X' },
      ]),
    ).toEqual([
      { id: 'opus', nome: 'Claude Opus', modelo: 'claude-opus-5-5' },
      { id: 'codex', nome: 'Codex', modelo: 'openai' },
      { id: 'x', nome: 'X' },
    ]);
  });

  it('repos não se repetem, mesmo com barra no fim ou outra caixa', () => {
    expect(
      reposDeVoz([
        { caminho: 'D:\\projetos\\app', nome: 'app' },
        { caminho: 'd:\\projetos\\app\\' },
        { caminho: '/repos/lib' },
        { caminho: '' },
      ]),
    ).toEqual([{ caminho: 'D:\\projetos\\app', nome: 'app' }, { caminho: '/repos/lib' }]);
  });
});

describe('utilidades', () => {
  it('base64 de áudio grande sem estourar a pilha', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(bytesParaBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(bytesParaBase64(new Uint8Array())).toBe('');
  });

  it('confere o endereço do servidor local', () => {
    expect(problemaNoEndpoint('http://127.0.0.1:8000/v1')).toBeUndefined();
    expect(problemaNoEndpoint(' https://whisper.exemplo.com/v1 ')).toBeUndefined();
    expect(problemaNoEndpoint('ftp://x')).toMatch(/http/);
    expect(problemaNoEndpoint('nada')).toMatch(/Invalid/);
  });
});

describe('modo de voz', () => {
  it('oferece os quatro modos, navegador primeiro e sem chave', () => {
    expect(modosDeVoz().map((m) => [m.id, m.chave])).toEqual([
      ['navegador', 'nao'],
      ['openai', 'sim'],
      ['groq', 'sim'],
      ['local', 'opcional'],
    ]);
    expect(nomeDoModo('groq')).toBe('Groq');
    expect(nomeDoModo(undefined)).toBe('off');
  });

  it('na IDE só grava quando o Core transcreve', () => {
    expect(vozNaIde({ configurado: true, modo: 'groq', provedor: 'groq' })).toEqual({
      pronta: true,
    });
    // Core antigo, sem modo no status.
    expect(vozNaIde({ configurado: true, provedor: 'openai' }).pronta).toBe(true);
    const navegador = vozNaIde({ configurado: true, modo: 'navegador' });
    expect(navegador.pronta).toBe(false);
    expect(navegador.aviso).toMatch(/phone app.*Win\+H/);
    expect(vozNaIde({ configurado: false }).aviso).toMatch(/Voice is off/);
    expect(vozNaIde({ configurado: false, modo: 'openai', motivo: 'falta a chave' }).aviso).toMatch(
      /OpenAI.*falta a chave/,
    );
    expect(vozNaIde(undefined).pronta).toBe(false);
  });
});

describe('voz em pt-BR', () => {
  afterEach(() => useLocale('en'));

  it('mensagens de erro e avisos saem em português', () => {
    useLocale('pt-br');
    expect(acaoDoPedido(pedido({ texto: '  ' }), {})).toEqual({
      tipo: 'erro',
      mensagem: 'O pedido ficou vazio. Fale ou escreva de novo.',
    });
    expect(acaoDoPedido(pedido({ intencao: 'mensagem' }), {})).toEqual({
      tipo: 'erro',
      mensagem: 'Não há conversa aberta no chat. Escolha "Conversa nova" ou "Tarefa".',
    });
    expect(vozNaIde(undefined).aviso).toBe('O FaKL Core não está respondendo.');
    expect(vozNaIde({ configurado: false, modo: 'openai', motivo: 'falta a chave' }).aviso).toBe(
      'A voz (OpenAI) não está pronta: falta a chave.',
    );
    expect(vozNaIde({ configurado: true, modo: 'navegador' }).aviso).toMatch(/celular.*Win\+H/);
    expect(problemaNoEndpoint('nada')).toMatch(/inválido/);
  });

  it('modos e intenções seguem o idioma escolhido depois do import', () => {
    expect(nomeDoModo('local')).toBe('Local whisper-compatible server');
    expect(ROTULOS_DE_INTENCAO.avulsa).toBe('New conversation');
    useLocale('pt-br');
    expect(nomeDoModo('local')).toBe('Servidor local compatível com whisper');
    expect(nomeDoModo(undefined)).toBe('desligado');
    expect(modosDeVoz()[0]?.nome).toBe('Reconhecimento do navegador');
    expect(rotuloDaIntencao('tarefa')).toBe('Tarefa');
    expect(ROTULOS_DE_INTENCAO.mensagem).toBe('Mensagem para a conversa ativa');
  });
});
