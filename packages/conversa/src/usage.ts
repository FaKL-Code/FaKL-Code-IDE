import type { AgentSessionInfo, AgentUsageInfo, CostTotals, DailyCap } from '@fakl/protocol';
import { currentLocale, l10n } from '@fakl/i18n';

/**
 * Formatação de uso, custo e tempo, igual na IDE e no celular. Sem DOM.
 */

export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace('.0', '')}k`;
  return String(count);
}

export function formatCost(cost: AgentUsageInfo['cost']): string {
  if (!cost) return '';
  const amount = cost.amount.toFixed(cost.amount < 1 ? 4 : 2);
  return cost.currency === 'USD' ? l10n.t('${0}', amount) : `${cost.currency} ${amount}`;
}

export interface UsageBreakdown {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  /** Da entrada, o que foi lido do cache (a um décimo do preço). */
  readonly cached: number;
  /** Parte da entrada e da saída no total, de 0 a 1. */
  readonly inputShare: number;
  readonly outputShare: number;
}

export function usageBreakdown(usage: AgentUsageInfo): UsageBreakdown {
  const total = Math.max(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total,
    cached: usage.cacheReadTokens ?? 0,
    inputShare: total > 0 ? usage.inputTokens / total : 0,
    outputShare: total > 0 ? usage.outputTokens / total : 0,
  };
}

/** Soma o uso das conversas; o custo só entra se todas usam a mesma moeda. */
export function sumUsage(sessions: readonly Pick<AgentSessionInfo, 'usage'>[]): AgentUsageInfo {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let amount = 0;
  let currency: string | undefined;
  let mixed = false;
  for (const { usage } of sessions) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    if (usage.cost) {
      if (currency && currency !== usage.cost.currency) mixed = true;
      currency = usage.cost.currency;
      amount += usage.cost.amount;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(currency && !mixed ? { cost: { amount, currency } } : {}),
  };
}

/** "agora", "há 3 min", "há 2 h" ou a data, para o carimbo das mensagens. */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return l10n.t('now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return l10n.t('{0} min ago', String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return l10n.t('{0} h ago', String(hours));
  return new Date(then).toLocaleDateString(currentLocale() === 'pt-br' ? 'pt-BR' : 'en-US');
}

/** Primeira linha do texto, cortada, para a prévia do raciocínio recolhido. */
export function preview(text: string, max = 70): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Iniciais do avatar: a primeira letra do nome, mais a da segunda palavra
 * quando ela também é uma palavra ("Claude Code" → CC, "Local 7B" → L).
 */
export function initials(nome: string): string {
  const [first = '', second = ''] = nome.trim().split(/\s+/);
  const extra = /^\p{L}/u.test(second) ? second.charAt(0) : '';
  return (first.charAt(0) + extra).toUpperCase() || '?';
}

/** Anel de uso de um provedor: quanto do teto do dia já foi. */
export interface UsageRing {
  readonly provedor: string;
  /** 0 a 1; sem teto, `undefined`. */
  readonly fracao?: number;
  readonly gasto: string;
  readonly teto?: string;
  readonly bloqueado: boolean;
}

export function usageRing(
  provedor: string,
  totals: CostTotals,
  cap: DailyCap | undefined,
  bloqueado: boolean,
): UsageRing {
  const tokens = totals.tokensEntrada + totals.tokensSaida;
  const usd = (v: number): string => l10n.t('${0}', v.toFixed(2));
  const tok = (v: number): string => `${formatTokens(v)} tok`;
  const gasto = totals.custoUsd > 0 ? usd(totals.custoUsd) : tok(tokens);
  // O teto em dólar vale quando existe; senão, o de tokens.
  if (cap?.custoUsd) {
    const fracao = Math.min(1, totals.custoUsd / cap.custoUsd);
    return { provedor, fracao, gasto: usd(totals.custoUsd), teto: usd(cap.custoUsd), bloqueado };
  }
  if (cap?.tokens) {
    const fracao = Math.min(1, tokens / cap.tokens);
    return { provedor, fracao, gasto: tok(tokens), teto: tok(cap.tokens), bloqueado };
  }
  return { provedor, gasto, bloqueado };
}

/** Quanto da janela de contexto está ocupado, de 0 a 1; sem informação, nada. */
export function contextShare(usage: AgentUsageInfo): number | undefined {
  const context = usage.context;
  if (!context || context.size <= 0) return undefined;
  return Math.min(1, Math.max(0, context.used / context.size));
}

/**
 * Última linha com texto, sem a marcação de markdown do começo, cortada: o
 * que o agente está dizendo agora, para as listas.
 */
export function lastLine(text: string, max = 140): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const line = lines.findLast((l) => l !== '' && !/^(```|~~~)/.test(l)) ?? '';
  const clean = line
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
    .replace(/[*_`]/g, '')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
