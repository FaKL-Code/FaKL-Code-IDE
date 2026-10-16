import { useLocale } from '@fakl/i18n';
import type { CostSummary } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { bar, providerLimits, statusText, worstLevel } from '../src/limits-model.js';

const summary: CostSummary = {
  dia: '2026-10-13',
  total: { tokensEntrada: 0, tokensSaida: 0, custoUsd: 6 },
  porProvedor: {
    anthropic: { tokensEntrada: 1000, tokensSaida: 500, custoUsd: 4 },
    openai: { tokensEntrada: 20_000, tokensSaida: 10_000, custoUsd: 0 },
    google: { tokensEntrada: 10, tokensSaida: 10, custoUsd: 2 },
  },
  porSessao: {},
  tetos: { anthropic: { custoUsd: 5 }, openai: { tokens: 40_000 }, google: { custoUsd: 2 } },
  bloqueados: ['google'],
};

describe('providerLimits', () => {
  it('ordena bloqueados primeiro e depois pelo uso', () => {
    const rows = providerLimits(summary, ['ollama']);
    expect(rows.map((r) => r.provedor)).toEqual(['google', 'anthropic', 'openai', 'ollama']);
    expect(rows[2]).toMatchObject({ fracao: 0.75, gasto: '30k tok', teto: '40k tok' });
    expect(rows[3]).toMatchObject({ gasto: '0 tok', bloqueado: false });
    expect(rows[3]?.fracao).toBeUndefined();
  });
});

describe('barra e nível', () => {
  afterEach(() => useLocale('en'));

  it('desenha a barra com largura fixa', () => {
    expect(bar(0.5, 4)).toBe('██░░');
    expect(bar(undefined, 4)).toBe('░░░░');
    expect(bar(2, 4)).toBe('████');
  });

  it('pega o pior nível e resume o texto da barra de status', () => {
    const rows = providerLimits(summary);
    expect(worstLevel(rows)).toBe('error');
    expect(worstLevel(providerLimits({ ...summary, bloqueados: [] }).slice(2))).toBe('ok');
    expect(statusText(rows, summary.total)).toBe(
      '$(dashboard) google 100% · anthropic 80% · openai 75%',
    );
    expect(statusText(providerLimits({ ...summary, tetos: {} }), summary.total)).toBe(
      '$(dashboard) $6.00',
    );
  });

  it('mostra o gasto em dólar no formato do idioma', () => {
    useLocale('pt-br');
    expect(statusText(providerLimits({ ...summary, tetos: {} }), summary.total)).toBe(
      '$(dashboard) US$ 6.00',
    );
  });
});
