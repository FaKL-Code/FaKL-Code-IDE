import { currentLocale, l10n } from '@fakl/i18n';

/** Parte do `economia.status` que a barra de status mostra. */
export interface EconomiaResumo {
  readonly modo: 'desligado' | 'equilibrado' | 'agressivo';
  readonly desde: string;
  readonly total: EconomiaNumeros;
  readonly hoje: EconomiaNumeros;
}

export interface EconomiaNumeros {
  readonly respostas: number;
  readonly repeticoes: number;
  readonly roteadas: number;
  readonly rebaixadas: number;
  readonly usdEstimado: number;
  readonly tokensEstimados: number;
}

/** 950 -> "950", 12400 -> "12,4 mil", 1250000 -> "1,25 mi" (no idioma da IDE). */
export function tokensCurtos(tokens: number): string {
  const formato = (valor: number, casas: number): string =>
    valor.toLocaleString(currentLocale(), { maximumFractionDigits: casas });
  if (tokens < 1_000) return formato(tokens, 0);
  if (tokens < 1_000_000) return l10n.t('{0} k', formato(tokens / 1_000, 1));
  return l10n.t('{0} M', formato(tokens / 1_000_000, 2));
}

export function modoRotulo(modo: EconomiaResumo['modo']): string {
  switch (modo) {
    case 'desligado':
      return l10n.t('Off');
    case 'equilibrado':
      return l10n.t('Balanced');
    case 'agressivo':
      return l10n.t('Aggressive');
  }
}

export function modoDescricao(modo: EconomiaResumo['modo']): string {
  switch (modo) {
    case 'desligado':
      return l10n.t('Tool answers go to the agents untouched; no routing by cost.');
    case 'equilibrado':
      return l10n.t(
        'Compact answers, repeated reads become a short notice, and spawn_agent picks the cheapest fit profile.',
      );
    case 'agressivo':
      return l10n.t(
        'Everything in Balanced, with a lower cap on long answers and empty fields removed.',
      );
  }
}

/** Texto da barra de status. */
export function textoDaBarra(resumo: EconomiaResumo): string {
  if (resumo.modo === 'desligado') return l10n.t('$(zap) Saving off');
  return l10n.t('$(zap) ~{0} tokens saved today', tokensCurtos(resumo.hoje.tokensEstimados));
}

/** Linhas do detalhe (tooltip e quadro de resumo). */
export function linhasDoResumo(resumo: EconomiaResumo): string[] {
  const { total, hoje } = resumo;
  const linhas = [
    l10n.t('Mode: {0}', modoRotulo(resumo.modo)),
    l10n.t('Today: ~{0} tokens saved', tokensCurtos(hoje.tokensEstimados)),
    l10n.t('Since {0}: ~{1} tokens saved', resumo.desde, tokensCurtos(total.tokensEstimados)),
    l10n.t(
      'Compacted answers: {0}; repeated reads avoided: {1}',
      String(total.respostas),
      String(total.repeticoes),
    ),
    l10n.t(
      'Tasks routed by cost: {0} ({1} to a cheaper profile)',
      String(total.roteadas),
      String(total.rebaixadas),
    ),
  ];
  if (total.usdEstimado > 0) {
    linhas.push(l10n.t('Estimated cost difference: ${0}', total.usdEstimado.toFixed(2)));
  }
  linhas.push(l10n.t('Tokens are estimated from characters (4 per token).'));
  return linhas;
}
