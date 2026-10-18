import { currentLocale, l10n } from '@fakl/i18n';
import type { ScorecardEntry, ScorecardPeriod } from '@fakl/protocol';

/** Nome do período na árvore, no QuickPick e na mensagem de lista vazia. */
export function periodLabel(period: ScorecardPeriod): string {
  switch (period) {
    case '7d':
      return l10n.t('Last 7 days');
    case '30d':
      return l10n.t('Last 30 days');
    case 'total':
      return l10n.t('All recorded history');
  }
}

/** Duração curta: 45s, 12m30s, 1h05m. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`;
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

function money(value: number): string {
  return l10n.t('${0}', value.toFixed(2));
}

/** Perfil com tarefas de menos: a taxa e as médias enganam, então a linha avisa. */
export function hasEnoughData(entry: ScorecardEntry, minimum: number): boolean {
  return entry.tarefas >= minimum;
}

/** Texto à direita do nome do perfil. */
export function entryDescription(entry: ScorecardEntry, minimum: number): string {
  const parts: string[] = [l10n.t('{0} task(s)', String(entry.tarefas))];
  if (!hasEnoughData(entry, minimum)) {
    parts.push(l10n.t('little data'));
  } else {
    if (entry.taxaAprovacao !== undefined) {
      parts.push(l10n.t('{0} approved', percent(entry.taxaAprovacao)));
    }
    if (entry.duracaoMediaMs !== undefined) parts.push(formatDuration(entry.duracaoMediaMs));
    if (entry.custoMedioTarefaUsd !== undefined) parts.push(money(entry.custoMedioTarefaUsd));
  }
  return parts.join(' · ');
}

/** Linhas do tooltip, em Markdown simples (uma por parágrafo). */
export function entryTooltipLines(entry: ScorecardEntry, minimum: number): string[] {
  const dash = '-';
  const lines = [
    entry.removido ? l10n.t('**{0}** (profile removed)', entry.nome) : `**${entry.nome}**`,
    l10n.t(
      'Tasks: {0} done, {1} failed, {2} canceled',
      String(entry.tarefasConcluidas),
      String(entry.tarefasFalhas),
      String(entry.tarefasCanceladas),
    ),
    l10n.t('Sessions: {0}', String(entry.sessoes)),
    l10n.t(
      'Average time: {0} · median: {1}',
      entry.duracaoMediaMs === undefined ? dash : formatDuration(entry.duracaoMediaMs),
      entry.duracaoMedianaMs === undefined ? dash : formatDuration(entry.duracaoMedianaMs),
    ),
    l10n.t(
      'Diff files: {0} accepted, {1} rejected · approval {2}',
      String(entry.arquivosAceitos),
      String(entry.arquivosRejeitados),
      entry.taxaAprovacao === undefined ? dash : percent(entry.taxaAprovacao),
    ),
    l10n.t(
      'Cost: {0} · average per task: {1}',
      money(entry.custoUsd),
      entry.custoMedioTarefaUsd === undefined ? dash : money(entry.custoMedioTarefaUsd),
    ),
    l10n.t(
      'Tokens: {0} in, {1} out',
      entry.tokensEntrada.toLocaleString(currentLocale()),
      entry.tokensSaida.toLocaleString(currentLocale()),
    ),
    l10n.t('Usage limits hit: {0}', String(entry.limites)),
  ];
  if (!hasEnoughData(entry, minimum)) {
    lines.push(
      l10n.t(
        'Fewer than {0} tasks: too little data to compare with other profiles.',
        String(minimum),
      ),
    );
  }
  lines.push(l10n.t('These are indirect signals; they do not measure the quality of the code.'));
  return lines;
}
