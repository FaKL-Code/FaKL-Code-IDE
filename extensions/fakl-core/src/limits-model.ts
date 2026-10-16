import { l10n } from '@fakl/i18n';
import type { CostSummary, CostTotals } from '@fakl/protocol';

const ZERO: CostTotals = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };

/** Quanto do teto diário um provedor já usou. */
export interface ProviderLimit {
  readonly provedor: string;
  /** 0 a 1; sem teto, `undefined`. */
  readonly fracao?: number;
  readonly gasto: string;
  readonly teto?: string;
  readonly bloqueado: boolean;
}

function usd(value: number): string {
  return l10n.t('${0}', value.toFixed(2));
}

function tokens(value: number): string {
  return value >= 1000 ? `${String(Math.round(value / 1000))}k tok` : `${String(value)} tok`;
}

/**
 * Uma linha por provedor: os do resumo do dia, os que têm teto e os dos perfis
 * (mesmo sem gasto ainda). Bloqueados primeiro, depois do mais ao menos usado.
 */
export function providerLimits(
  summary: CostSummary,
  known: readonly string[] = [],
): ProviderLimit[] {
  const names = new Set([
    ...known,
    ...Object.keys(summary.porProvedor),
    ...Object.keys(summary.tetos),
  ]);
  const rows = [...names].map((provedor): ProviderLimit => {
    const totals = summary.porProvedor[provedor] ?? ZERO;
    const cap = summary.tetos[provedor];
    const bloqueado = summary.bloqueados.includes(provedor);
    const used = totals.tokensEntrada + totals.tokensSaida;
    if (cap?.custoUsd) {
      return {
        provedor,
        fracao: Math.min(1, totals.custoUsd / cap.custoUsd),
        gasto: usd(totals.custoUsd),
        teto: usd(cap.custoUsd),
        bloqueado,
      };
    }
    if (cap?.tokens) {
      return {
        provedor,
        fracao: Math.min(1, used / cap.tokens),
        gasto: tokens(used),
        teto: tokens(cap.tokens),
        bloqueado,
      };
    }
    return {
      provedor,
      gasto: totals.custoUsd > 0 ? usd(totals.custoUsd) : tokens(used),
      bloqueado,
    };
  });
  return rows.sort(
    (a, b) =>
      Number(b.bloqueado) - Number(a.bloqueado) ||
      (b.fracao ?? -1) - (a.fracao ?? -1) ||
      a.provedor.localeCompare(b.provedor),
  );
}

/** Barra de texto de largura fixa, como `███░░░░░`. */
export function bar(fracao: number | undefined, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, fracao ?? 0)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export type LimitLevel = 'ok' | 'warn' | 'error';

export function levelOf(row: Pick<ProviderLimit, 'fracao' | 'bloqueado'>): LimitLevel {
  if (row.bloqueado || (row.fracao ?? 0) >= 1) return 'error';
  return (row.fracao ?? 0) >= 0.8 ? 'warn' : 'ok';
}

/** Pior situação entre os provedores, para colorir o item da barra de status. */
export function worstLevel(rows: readonly ProviderLimit[]): LimitLevel {
  const levels = rows.map(levelOf);
  if (levels.includes('error')) return 'error';
  return levels.includes('warn') ? 'warn' : 'ok';
}

/** Texto curto da barra de status: só os provedores com teto, ou o gasto total. */
export function statusText(rows: readonly ProviderLimit[], total: CostTotals): string {
  const capped = rows.filter((row) => row.fracao !== undefined).slice(0, 3);
  if (capped.length === 0) return `$(dashboard) ${usd(total.custoUsd)}`;
  const parts = capped.map(
    (row) => `${row.provedor} ${String(Math.round((row.fracao ?? 0) * 100))}%`,
  );
  return `$(dashboard) ${parts.join(' · ')}`;
}
