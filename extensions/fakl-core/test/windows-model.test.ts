import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCaps,
  describeWindow,
  providerCaps,
  rowWindows,
  untilReset,
  windowsText,
  withCaps,
  type ProviderWindows,
} from '../src/windows-model.js';

const H = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

describe('tetos e textos', () => {
  const now = at('2026-10-13T12:00:00Z');

  it('aplica o teto configurado', () => {
    expect(withCaps({ tokens: 250 }, 1000)?.fracao).toBe(0.25);
    expect(withCaps({ tokens: 2000 }, 1000)?.fracao).toBe(1);
    expect(withCaps({ tokens: 250 }, undefined)?.fracao).toBeUndefined();
  });

  it('descreve janelas e prazo', () => {
    expect(describeWindow({ fracao: 0.426 })).toBe('43%');
    expect(describeWindow({ tokens: 380_000 })).toBe('380k tok');
    expect(describeWindow({ requisicoes: 12, tokens: 380_000 })).toBe('12 req');
    expect(describeWindow(undefined)).toBe('—');
    expect(untilReset(now + 135 * 60_000, now)).toBe('2h 15min');
    expect(untilReset(now + 40 * 60_000, now)).toBe('40min');
    expect(untilReset(now + (3 * 24 + 5) * H, now)).toBe('3d 5h');
    expect(untilReset(now - 1, now)).toBe('now');
  });
});

describe('tetos por provedor', () => {
  it('lê fakl.limits.providers e ignora o que não é número positivo', () => {
    const caps = providerCaps({
      google: { dailyRequests: 1000, weeklyTokens: 0, lixo: 3 },
      openai: 'errado',
    });
    expect(caps.get('google')).toEqual({ dailyRequests: 1000 });
    expect(caps.has('openai')).toBe(false);
    expect(caps.get('anthropic')).toEqual({});
  });

  it('mantém as chaves antigas do Claude, e a configuração nova vence', () => {
    expect(providerCaps({}, { sessionTokens: 500, weeklyTokens: 0 }).get('anthropic')).toEqual({
      sessionTokens: 500,
    });
    expect(
      providerCaps(
        { anthropic: { sessionTokens: 900 } },
        { sessionTokens: 500, weeklyTokens: 7000 },
      ).get('anthropic'),
    ).toEqual({ sessionTokens: 900, weeklyTokens: 7000 });
  });

  it('aplica os tetos às janelas estimadas; o percentual real do provedor fica', () => {
    const rows: ProviderWindows[] = [
      {
        provedor: 'anthropic',
        sessao: { tokens: 250 },
        semana: { tokens: 1000 },
        origem: 'estimado',
      },
      { provedor: 'google', dia: { requisicoes: 50, tokens: 9000 }, origem: 'estimado' },
      { provedor: 'openai', sessao: { fracao: 0.4, tokens: 10 }, origem: 'real' },
    ];
    const caps = providerCaps(
      { google: { dailyRequests: 200, dailyTokens: 10 }, openai: { sessionTokens: 10 } },
      { sessionTokens: 1000 },
    );
    expect(applyCaps(rows, caps)).toEqual([
      {
        provedor: 'anthropic',
        sessao: { tokens: 250, fracao: 0.25 },
        semana: { tokens: 1000 },
        origem: 'estimado',
      },
      // Na cota diária, o teto de requisições vale mais que o de tokens.
      {
        provedor: 'google',
        dia: { requisicoes: 50, tokens: 9000, fracao: 0.25 },
        origem: 'estimado',
      },
      rows[2],
    ]);
  });
});

describe('windowsText', () => {
  it('usa o apelido da conta, o nome do provedor, a cota diária e o sem dados', () => {
    const text = windowsText([
      { provedor: 'anthropic', nome: 'Trabalho', sessao: { tokens: 380_000 }, origem: 'estimado' },
      { provedor: 'openai', sessao: { fracao: 0.4 }, semana: { fracao: 0.1 }, origem: 'real' },
      {
        provedor: 'google',
        dia: { requisicoes: 12 },
        semana: { tokens: 5000 },
        origem: 'estimado',
      },
      { provedor: 'openai', nome: 'Codex 2', origem: 'estimado', semDados: true },
    ]);
    expect(text).toBe(
      '$(clock) Trabalho 5h 380k tok · wk —  Codex 5h 40% · wk 10%  Gemini day 12 req · wk 5k tok  Codex 2 no data',
    );
  });
});

describe('textos em pt-BR', () => {
  afterEach(() => useLocale('en'));

  it('mostra a barra de status e os rótulos em português', () => {
    useLocale('pt-br');
    const now = at('2026-10-13T12:00:00Z');
    expect(untilReset(now, now)).toBe('agora');
    expect(
      windowsText([
        { provedor: 'anthropic', sessao: { fracao: 0.5 }, semana: { fracao: 0.2 }, origem: 'real' },
        { provedor: 'google', dia: { requisicoes: 12 }, origem: 'estimado' },
        { provedor: 'openai', origem: 'estimado', semDados: true },
      ]),
    ).toBe('$(clock) Claude 5h 50% · sem 20%  Gemini dia 12 req · sem —  Codex sem dados');
    expect(
      rowWindows({ provedor: 'anthropic', origem: 'estimado' }).map(({ label }) => label),
    ).toEqual(['Sessão 5h', 'Semana']);
    expect(
      rowWindows({ provedor: 'google', dia: {}, origem: 'estimado' }).map(({ label }) => label),
    ).toEqual(['Hoje', 'Semana']);
  });
});
