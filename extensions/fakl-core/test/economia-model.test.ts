import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  linhasDoResumo,
  textoDaBarra,
  tokensCurtos,
  type EconomiaResumo,
} from '../src/economia-model.js';

const numeros = {
  respostas: 12,
  repeticoes: 3,
  roteadas: 4,
  rebaixadas: 2,
  usdEstimado: 0,
  tokensEstimados: 12_400,
};

const resumo = (extra: Partial<EconomiaResumo> = {}): EconomiaResumo => ({
  modo: 'equilibrado',
  desde: '2026-10-01',
  total: { ...numeros, tokensEstimados: 1_250_000 },
  hoje: numeros,
  ...extra,
});

describe('economia de tokens: modelo da barra', () => {
  afterEach(() => {
    useLocale('en');
  });

  it('abrevia os tokens', () => {
    useLocale('pt-br');
    expect(tokensCurtos(950)).toBe('950');
    expect(tokensCurtos(12_400)).toBe('12,4 mil');
    expect(tokensCurtos(1_250_000)).toBe('1,25 mi');
  });

  it('mostra o que foi economizado hoje, ou que está desligada', () => {
    useLocale('pt-br');
    expect(textoDaBarra(resumo())).toBe('$(zap) ~12,4 mil tokens economizados hoje');
    expect(textoDaBarra(resumo({ modo: 'desligado' }))).toBe('$(zap) Economia desligada');
  });

  it('o detalhe traz modo, totais, roteamento e a nota da estimativa', () => {
    useLocale('pt-br');
    const linhas = linhasDoResumo(resumo());
    expect(linhas[0]).toBe('Modo: Equilibrado');
    expect(linhas.join('\n')).toContain(
      'Respostas compactadas: 12; leituras repetidas evitadas: 3',
    );
    expect(linhas.join('\n')).toContain(
      'Tarefas roteadas por custo: 4 (2 para um perfil mais barato)',
    );
    expect(linhas.join('\n')).not.toContain('Diferença de custo');
    expect(linhas.at(-1)).toContain('estimados pelos caracteres');
  });

  it('mostra o cache da busca semântica à parte, só quando houve', () => {
    useLocale('pt-br');
    expect(linhasDoResumo(resumo()).join(' | ')).not.toContain('Cache da busca semântica');
    const com = linhasDoResumo(
      resumo({ total: { ...numeros, embeddingsEvitados: 7, tokensEmbeddings: 1_500 } }),
    ).join(' | ');
    expect(com).toContain('Cache da busca semântica: 7 trechos e perguntas');
    expect(com).toContain('1,5 mil tokens de embeddings');
  });

  it('só mostra a diferença de custo quando há dados do placar', () => {
    useLocale('pt-br');
    const com = linhasDoResumo(resumo({ total: { ...numeros, usdEstimado: 1.234 } })).join('\n');
    expect(com).toContain('US$1.23');
  });
});
