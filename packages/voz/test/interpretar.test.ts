import { describe, expect, it } from 'vitest';

import { descreverPedido, interpretar } from '../src/interpretar.js';
import type { ContextoDeVoz } from '../src/interpretar.js';

const contexto: ContextoDeVoz = {
  perfis: [
    { id: 'claude-opus', nome: 'Claude Opus', modelo: 'opus' },
    { id: 'claude-sonnet', nome: 'Claude Sonnet', modelo: 'sonnet' },
    { id: 'claude-haiku', nome: 'Claude Haiku', modelo: 'haiku' },
    { id: 'codex', nome: 'Codex', modelo: 'gpt-5' },
    { id: 'gemini', nome: 'Gemini' },
  ],
  repos: [
    { caminho: 'D:/projetos/fakl-code-ide' },
    { caminho: '/home/x/loja-online', nome: 'Loja Online' },
    { caminho: 'C:\\dev\\api' },
  ],
};
const comConversa: ContextoDeVoz = { ...contexto, conversaAberta: true };

describe('interpretar: tarefa', () => {
  it('"cria uma tarefa para ..."', () => {
    const p = interpretar('cria uma tarefa para adicionar login com Google', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Adicionar login com Google');
    expect(p.titulo).toBe('Adicionar login com Google');
    expect(p.comecarAgora).toBe(true);
    expect(p.confianca).toBeGreaterThanOrEqual(0.8);
    expect(p.reconhecido).toEqual(['tarefa']);
  });

  it('"crie uma nova tarefa: ..."', () => {
    const p = interpretar('Crie uma nova tarefa: corrigir o bug do carrinho', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Corrigir o bug do carrinho');
  });

  it('"tarefa: ..."', () => {
    const p = interpretar('tarefa: refatorar o módulo de pagamentos', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Refatorar o módulo de pagamentos');
  });

  it('"quero uma tarefa pra ..."', () => {
    const p = interpretar('quero uma tarefa pra revisar os testes', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Revisar os testes');
  });

  it('"manda o maestro ..."', () => {
    const p = interpretar('manda o maestro migrar o banco para postgres', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Migrar o banco para postgres');
  });

  it('"orquestra ..."', () => {
    const p = interpretar('orquestra migrar o banco', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Migrar o banco');
  });

  it('ignora interjeições no começo', () => {
    const p = interpretar('ei, por favor cria uma tarefa para ajustar o menu', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Ajustar o menu');
  });

  it('perfil, repositório e critério falados juntos', () => {
    const p = interpretar(
      'criar tarefa para adicionar login com o opus no projeto fakl code ide critério pnpm test e pnpm check',
      contexto,
    );
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('Adicionar login');
    expect(p.perfilId).toBe('claude-opus');
    expect(p.repoPath).toBe('D:/projetos/fakl-code-ide');
    expect(p.criterio).toEqual(['pnpm test', 'pnpm check']);
    expect(p.comecarAgora).toBe(true);
    expect(p.reconhecido).toEqual([
      'tarefa',
      'perfil: Claude Opus',
      'repositório: fakl-code-ide',
      'critério: pnpm test, pnpm check',
    ]);
  });

  it('critério com dois pontos e ponto final', () => {
    const p = interpretar(
      'Crie uma tarefa para revisão do módulo de pagamento, critério: pnpm check.',
      contexto,
    );
    expect(p.criterio).toEqual(['pnpm check']);
    expect(p.texto).toBe('Revisão do módulo de pagamento');
  });

  it('a palavra critério no meio do pedido não vira critério', () => {
    const p = interpretar('cria uma tarefa para revisar o critério de busca', contexto);
    expect(p.criterio).toBeUndefined();
    expect(p.texto).toBe('Revisar o critério de busca');
  });

  it('"não começa ainda"', () => {
    const p = interpretar('cria uma tarefa para atualizar o readme e não começa ainda', contexto);
    expect(p.comecarAgora).toBe(false);
    expect(p.texto).toBe('Atualizar o readme');
    expect(p.reconhecido).toContain('não começar agora');
  });

  it('"só cria a tarefa"', () => {
    const p = interpretar('só cria a tarefa de limpar o cache', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.comecarAgora).toBe(false);
    expect(p.texto).toBe('Limpar o cache');
  });

  it('"sem começar"', () => {
    const p = interpretar('cria tarefa sem começar ajustar o layout', contexto);
    expect(p.comecarAgora).toBe(false);
    expect(p.texto).toBe('Ajustar o layout');
  });

  it('"deixa pra depois"', () => {
    const p = interpretar('cria uma tarefa para corrigir o lint deixa pra depois', contexto);
    expect(p.comecarAgora).toBe(false);
    expect(p.texto).toBe('Corrigir o lint');
  });

  it('"e começa agora" no fim sai do texto', () => {
    const p = interpretar('cria uma tarefa para trocar o logo e começa agora', contexto);
    expect(p.comecarAgora).toBe(true);
    expect(p.texto).toBe('Trocar o logo');
  });

  it('funciona sem acento e em caixa alta', () => {
    const p = interpretar('CRIE UMA TAREFA PARA ADICIONAR LOGIN COM O OPUS', contexto);
    expect(p.intencao).toBe('tarefa');
    expect(p.perfilId).toBe('claude-opus');
    expect(p.texto).toBe('ADICIONAR LOGIN');
  });

  it('fala sem pontuação: o ditado vira sinais no texto e no título', () => {
    const p = interpretar(
      'cria uma tarefa para adicionar botão de voltar vírgula e centralizar o título ponto final',
      contexto,
    );
    expect(p.texto).toBe('Adicionar botão de voltar, e centralizar o título.');
    expect(p.titulo).toBe('Adicionar botão de voltar, e centralizar o título');
  });

  it('corta o título em palavra, até 80 caracteres', () => {
    const p = interpretar(
      'cria uma tarefa para implementar a autenticação com múltiplos fatores e recuperação de senha por email para todos os usuários do sistema',
      contexto,
    );
    const titulo = p.titulo ?? '';
    expect(titulo.length).toBeGreaterThan(40);
    expect(titulo.length).toBeLessThanOrEqual(80);
    expect(p.texto.startsWith(titulo)).toBe(true);
    expect(p.texto.charAt(titulo.length)).toBe(' ');
  });

  it('perfil ambíguo não é definido e a menção fica no texto', () => {
    const p = interpretar('cria uma tarefa para ajustar o css com o claude', contexto);
    expect(p.perfilId).toBeUndefined();
    expect(p.texto).toBe('Ajustar o css com o claude');
  });

  it('"em" sem repositório conhecido não vira repositório', () => {
    const p = interpretar('cria uma tarefa para ajustar o botão em telas pequenas', contexto);
    expect(p.repoPath).toBeUndefined();
    expect(p.texto).toBe('Ajustar o botão em telas pequenas');
  });

  it('repositório pelo último segmento de um caminho do Windows', () => {
    const p = interpretar('cria tarefa na pasta api para versionar as rotas', contexto);
    expect(p.repoPath).toBe('C:\\dev\\api');
    expect(p.texto).toBe('Versionar as rotas');
  });
});

describe('interpretar: avulsa', () => {
  it('"abre uma conversa nova com o sonnet ..."', () => {
    const p = interpretar(
      'abre uma conversa nova com o sonnet e explica o que faz o scheduler',
      contexto,
    );
    expect(p.intencao).toBe('avulsa');
    expect(p.perfilId).toBe('claude-sonnet');
    expect(p.texto).toBe('Explica o que faz o scheduler');
    expect(p.confianca).toBeGreaterThanOrEqual(0.8);
  });

  it('"pergunta pro gemini ..."', () => {
    const p = interpretar('pergunta pro gemini qual é a diferença entre map e flatMap', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.perfilId).toBe('gemini');
    expect(p.texto).toBe('Qual é a diferença entre map e flatMap');
  });

  it('"pede pro codex ..."', () => {
    const p = interpretar('pede pro codex revisar o diff', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.perfilId).toBe('codex');
    expect(p.texto).toBe('Revisar o diff');
  });

  it('"pede pro" sem perfil conhecido não é marcador', () => {
    const p = interpretar('pede pro fulano revisar o diff', contexto);
    expect(p.confianca).toBeLessThan(0.5);
  });

  it('"execução avulsa no codex ..."', () => {
    const p = interpretar('execução avulsa no codex para listar os arquivos grandes', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.perfilId).toBe('codex');
    expect(p.texto).toBe('Listar os arquivos grandes');
  });

  it('"roda um agente haiku num worktree ..."', () => {
    const p = interpretar('roda um agente haiku num worktree para escrever testes', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.perfilId).toBe('claude-haiku');
    expect(p.worktree).toBe(true);
    expect(p.texto).toBe('Escrever testes');
    expect(p.reconhecido).toContain('worktree');
  });

  it('"nova conversa" sozinha', () => {
    const p = interpretar('nova conversa', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.texto).toBe('');
    expect(p.confianca).toBeGreaterThanOrEqual(0.8);
  });

  it('"sem worktree" e perfil por parte do modelo', () => {
    const p = interpretar(
      'inicia um novo agente sem worktree com o gpt para otimizar queries',
      contexto,
    );
    expect(p.intencao).toBe('avulsa');
    expect(p.worktree).toBe(false);
    expect(p.perfilId).toBe('codex');
    expect(p.texto).toBe('Otimizar queries');
  });

  it('repositório pelo nome dado, com falta de hífen e acento', () => {
    const p = interpretar(
      'abre uma conversa no repositório loja online para checar o estoque',
      contexto,
    );
    expect(p.intencao).toBe('avulsa');
    expect(p.repoPath).toBe('/home/x/loja-online');
    expect(p.texto).toBe('Checar o estoque');
    expect(p.reconhecido).toEqual(['execução avulsa', 'repositório: Loja Online']);
  });
});

describe('interpretar: mensagem', () => {
  it('"responde pra conversa que ..."', () => {
    const p = interpretar('responde pra conversa que pode seguir com a opção dois', comConversa);
    expect(p.intencao).toBe('mensagem');
    expect(p.texto).toBe('Pode seguir com a opção dois');
    expect(p.confianca).toBeGreaterThanOrEqual(0.8);
  });

  it('"manda pro agente ..." mesmo sem conversa aberta', () => {
    const p = interpretar('manda pro agente rodar os testes de novo', contexto);
    expect(p.intencao).toBe('mensagem');
    expect(p.texto).toBe('Rodar os testes de novo');
  });

  it('"na conversa atual ..."', () => {
    const p = interpretar('na conversa atual explica esse erro', comConversa);
    expect(p.intencao).toBe('mensagem');
    expect(p.texto).toBe('Explica esse erro');
  });

  it('mensagem não tira perfil do texto', () => {
    const p = interpretar('responde diz que o opus ficou lento', comConversa);
    expect(p.intencao).toBe('mensagem');
    expect(p.perfilId).toBeUndefined();
  });
});

describe('interpretar: sem marcador', () => {
  it('com conversa aberta vira mensagem, com confiança baixa', () => {
    const p = interpretar('o que é esse erro de timeout', comConversa);
    expect(p.intencao).toBe('mensagem');
    expect(p.texto).toBe('O que é esse erro de timeout');
    expect(p.confianca).toBeLessThan(0.5);
    expect(p.reconhecido).toEqual([]);
  });

  it('sem conversa aberta vira avulsa, com confiança baixa', () => {
    const p = interpretar('o que é esse erro de timeout', contexto);
    expect(p.intencao).toBe('avulsa');
    expect(p.confianca).toBeLessThan(0.5);
  });

  it('o padrão do contexto vence', () => {
    const p = interpretar('o que é esse erro de timeout', { ...comConversa, padrao: 'tarefa' });
    expect(p.intencao).toBe('tarefa');
    expect(p.texto).toBe('O que é esse erro de timeout');
    expect(p.titulo).toBe('O que é esse erro de timeout');
  });
});

describe('descreverPedido', () => {
  it('descreve a tarefa', () => {
    const p = interpretar(
      'cria uma tarefa para adicionar login com o opus no projeto fakl code ide',
      contexto,
    );
    expect(descreverPedido(p, contexto)).toBe(
      'Criar a tarefa “Adicionar login” em fakl-code-ide com o maestro Claude Opus e começar agora',
    );
  });

  it('descreve a tarefa sem começar e com critério', () => {
    const p = interpretar(
      'cria uma tarefa para trocar o logo critério pnpm test e não começa ainda',
      contexto,
    );
    expect(descreverPedido(p, contexto)).toBe(
      'Criar a tarefa “Trocar o logo” (critério: pnpm test) sem começar agora',
    );
  });

  it('descreve a conversa nova', () => {
    const p = interpretar('abre uma conversa nova com o sonnet explica isso', contexto);
    expect(descreverPedido(p, contexto)).toBe(
      'Abrir conversa nova com Claude Sonnet: “Explica isso”',
    );
  });

  it('descreve a mensagem', () => {
    const p = interpretar('responde pra conversa pode seguir', comConversa);
    expect(descreverPedido(p, comConversa)).toBe('Mandar para a conversa aberta: “Pode seguir”');
  });

  it('corta texto longo com reticências', () => {
    const p = interpretar(`responde pra conversa ${'palavra '.repeat(40)}`, comConversa);
    const linha = descreverPedido(p, comConversa);
    expect(linha).toContain('…”');
    expect(linha.length).toBeLessThanOrEqual(160);
  });
});
