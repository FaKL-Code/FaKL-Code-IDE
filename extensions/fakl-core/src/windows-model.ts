/**
 * Janelas de uso dos planos (ADR 0026): a sessão de 5 horas, a cota diária do
 * Gemini e a semana. O Core lê os registros dos CLIs (`usage.windows`); aqui
 * ficam os tetos que o usuário informa e os textos da barra de status.
 */

import { l10n } from '@fakl/i18n';
import { providerName, type ProviderWindows, type UsageWindow } from '@fakl/protocol';

export type { ProviderWindows, UsageWindow } from '@fakl/protocol';

/** Teto do plano de um provedor, em tokens (e requisições na cota diária). */
export interface ProviderCaps {
  readonly sessionTokens?: number;
  readonly dailyTokens?: number;
  readonly dailyRequests?: number;
  readonly weeklyTokens?: number;
}

const CAP_KEYS = ['sessionTokens', 'dailyTokens', 'dailyRequests', 'weeklyTokens'] as const;

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Tetos de `fakl.limits.providers` por provedor. O Claude ainda aceita as
 * chaves antigas `fakl.limits.claude.sessionTokens` e `weeklyTokens`, que
 * valem quando o provedor não tem o mesmo teto na configuração nova.
 */
export function providerCaps(
  providers: unknown,
  legacyClaude: { readonly sessionTokens?: unknown; readonly weeklyTokens?: unknown } = {},
): Map<string, ProviderCaps> {
  const caps = new Map<string, ProviderCaps>();
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [provedor, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry: Record<string, number> = {};
      for (const key of CAP_KEYS) {
        const value = positive((raw as Record<string, unknown>)[key]);
        if (value !== undefined) entry[key] = value;
      }
      caps.set(provedor, entry);
    }
  }
  const legacy = {
    sessionTokens: positive(legacyClaude.sessionTokens),
    weeklyTokens: positive(legacyClaude.weeklyTokens),
  };
  const claude = caps.get('anthropic') ?? {};
  caps.set('anthropic', {
    ...(legacy.sessionTokens !== undefined ? { sessionTokens: legacy.sessionTokens } : {}),
    ...(legacy.weeklyTokens !== undefined ? { weeklyTokens: legacy.weeklyTokens } : {}),
    ...claude,
  });
  return caps;
}

/** Aplica os tetos de tokens configurados, quando existem. */
export function withCaps(
  window: UsageWindow | undefined,
  cap: number | undefined,
): UsageWindow | undefined {
  if (!window || !cap || cap <= 0 || window.tokens === undefined) return window;
  return { ...window, fracao: Math.min(1, window.tokens / cap) };
}

/** Cota diária: o teto de requisições vale mais que o de tokens (a do Gemini é por requisições). */
function withDailyCaps(
  window: UsageWindow | undefined,
  caps: ProviderCaps,
): UsageWindow | undefined {
  if (!window) return window;
  if (caps.dailyRequests && window.requisicoes !== undefined) {
    return { ...window, fracao: Math.min(1, window.requisicoes / caps.dailyRequests) };
  }
  return withCaps(window, caps.dailyTokens);
}

/** Percentual de cada janela estimada a partir dos tetos do provedor; as reais ficam como vieram. */
export function applyCaps(
  rows: readonly ProviderWindows[],
  caps: ReadonlyMap<string, ProviderCaps>,
): ProviderWindows[] {
  return rows.map((row) => {
    const cap = caps.get(row.provedor);
    if (!cap || row.origem === 'real') return row;
    const sessao = withCaps(row.sessao, cap.sessionTokens);
    const dia = withDailyCaps(row.dia, cap);
    const semana = withCaps(row.semana, cap.weeklyTokens);
    return {
      ...row,
      ...(sessao ? { sessao } : {}),
      ...(dia ? { dia } : {}),
      ...(semana ? { semana } : {}),
    };
  });
}

/** "2h 15min", "40min" ou "agora" (no idioma da IDE) até o instante dado. */
export function untilReset(resetaEm: number | undefined, now: number): string {
  if (resetaEm === undefined) return '';
  const minutes = Math.max(0, Math.ceil((resetaEm - now) / 60_000));
  if (minutes === 0) return l10n.t('now');
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    return `${String(days)}d ${String(Math.floor((minutes % (24 * 60)) / 60))}h`;
  }
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}min`
    : `${String(minutes)}min`;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return tokens >= 1000 ? `${String(Math.round(tokens / 1000))}k` : String(tokens);
}

/** "42%" com percentual, "12 req" na cota por requisições, "380k tok" só com tokens, "—" sem dado. */
export function describeWindow(window: UsageWindow | undefined): string {
  if (!window) return '—';
  if (window.fracao !== undefined) return `${String(Math.round(window.fracao * 100))}%`;
  if (window.requisicoes !== undefined) return `${String(window.requisicoes)} req`;
  return window.tokens === undefined ? '—' : `${compact(window.tokens)} tok`;
}

export function rowName(row: ProviderWindows): string {
  return row.nome ?? providerName(row.provedor);
}

/** As janelas que a linha tem, com o rótulo curto (barra) e o longo (tooltip). */
export function rowWindows(
  row: ProviderWindows,
): { short: string; label: string; window: UsageWindow | undefined }[] {
  if (row.semDados) return [];
  if (row.dia) {
    return [
      { short: l10n.t('day'), label: l10n.t('Today'), window: row.dia },
      { short: l10n.t('wk'), label: l10n.t('Week'), window: row.semana },
    ];
  }
  return [
    { short: '5h', label: l10n.t('5h session'), window: row.sessao },
    { short: l10n.t('wk'), label: l10n.t('Week'), window: row.semana },
  ];
}

export function windowsText(rows: readonly ProviderWindows[]): string {
  const parts = rows.map((row) =>
    row.semDados
      ? l10n.t('{0} no data', rowName(row))
      : `${rowName(row)} ${rowWindows(row)
          .map(({ short, window }) => `${short} ${describeWindow(window)}`)
          .join(' · ')}`,
  );
  return `$(clock) ${parts.join('  ')}`;
}
