import { describe, expect, it } from 'vitest';

import { juntarDitado, normalizarDitado } from '../src/ditado.js';

describe('normalizarDitado', () => {
  it('troca vírgula e ponto final pelos sinais', () => {
    expect(normalizarDitado('olá vírgula tudo bem ponto final')).toBe('Olá, tudo bem.');
  });

  it('entende interrogação e exclamação', () => {
    expect(normalizarDitado('você vem amanhã ponto de interrogação')).toBe('Você vem amanhã?');
    expect(normalizarDitado('que ótimo ponto de exclamação')).toBe('Que ótimo!');
  });

  it('entende dois pontos, ponto e vírgula e ponto no fim', () => {
    expect(normalizarDitado('lista dois pontos maçã vírgula pera ponto e vírgula uva ponto')).toBe(
      'Lista: maçã, pera; uva.',
    );
  });

  it('"ponto" só vira sinal no fim, antes de "final" ou antes de quebra de linha', () => {
    expect(normalizarDitado('terminei ponto')).toBe('Terminei.');
    expect(normalizarDitado('terminei ponto nova linha começando outra')).toBe(
      'Terminei.\nComeçando outra',
    );
    expect(normalizarDitado('cadastrar ponto de venda novo')).toBe('Cadastrar ponto de venda novo');
    expect(normalizarDitado('o ponto é simples')).toBe('O ponto é simples');
  });

  it('quebra linha e parágrafo, com maiúscula depois', () => {
    expect(normalizarDitado('primeira linha nova linha segunda linha')).toBe(
      'Primeira linha\nSegunda linha',
    );
    expect(normalizarDitado('assunto um próxima linha assunto dois')).toBe(
      'Assunto um\nAssunto dois',
    );
    expect(normalizarDitado('fim do assunto novo parágrafo outro assunto')).toBe(
      'Fim do assunto\n\nOutro assunto',
    );
  });

  it('parênteses e aspas ficam coladas ao conteúdo', () => {
    expect(normalizarDitado('chamar a função abre parênteses x fecha parênteses ponto final')).toBe(
      'Chamar a função (x).',
    );
    expect(normalizarDitado('ele disse abre aspas vamos fecha aspas ponto final')).toBe(
      'Ele disse "vamos".',
    );
  });

  it('hífen cola as palavras', () => {
    expect(normalizarDitado('guarda hífen chuva')).toBe('Guarda-chuva');
  });

  it('ignora caixa e acento ao detectar', () => {
    expect(normalizarDitado('OLA VIRGULA mundo PONTO FINAL')).toBe('OLA, mundo.');
  });

  it('tira espaço duplicado e espaço antes de sinal', () => {
    expect(normalizarDitado('a   b')).toBe('A b');
    expect(normalizarDitado('olá , mundo .')).toBe('Olá, mundo.');
  });

  it('põe maiúscula depois de ponto, interrogação e exclamação', () => {
    expect(normalizarDitado('oi. tudo bem? sim! claro')).toBe('Oi. Tudo bem? Sim! Claro');
  });

  it('é idempotente para texto já pontuado', () => {
    const texto = 'Olá, tudo bem? Sim.\nOutra linha (com nota) e "aspas".';
    expect(normalizarDitado(texto)).toBe(texto);
    const falado = normalizarDitado('um vírgula dois ponto final');
    expect(normalizarDitado(falado)).toBe(falado);
  });

  it('não estraga nomes de arquivo nem números', () => {
    expect(normalizarDitado('abrir o arquivo index.ts e somar 3.5')).toBe(
      'Abrir o arquivo index.ts e somar 3.5',
    );
  });

  it('devolve vazio para texto vazio', () => {
    expect(normalizarDitado('')).toBe('');
    expect(normalizarDitado('   ')).toBe('');
  });
});

describe('juntarDitado', () => {
  it('não põe espaço quando o anterior é vazio ou termina em quebra de linha', () => {
    expect(juntarDitado('', 'olá')).toBe('olá');
    expect(juntarDitado('Olá\n', 'mundo')).toBe('Olá\nmundo');
  });

  it('junta com um espaço', () => {
    expect(juntarDitado('Olá', 'mundo')).toBe('Olá mundo');
    expect(juntarDitado('Olá ', 'mundo')).toBe('Olá mundo');
  });

  it('não põe espaço antes de pontuação do novo trecho', () => {
    expect(juntarDitado('Olá', ', tudo')).toBe('Olá, tudo');
    expect(juntarDitado('Olá', '.')).toBe('Olá.');
  });

  it('mantém o anterior quando o novo é vazio', () => {
    expect(juntarDitado('Olá', '')).toBe('Olá');
  });
});
