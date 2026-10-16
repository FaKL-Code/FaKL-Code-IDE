import { l10n } from '@fakl/i18n';
import type { Run, RunStatus, TaskStatus } from '@fakl/protocol';

const ACTIVE = new Set<Run['status']>(['executando', 'pausada', 'aguardando-decisão']);

/** Falhas com entrega no branch conservam o trabalho e podem ser retomadas pelo Core. */
export function canResumeRun(run: Run): boolean {
  return (
    run.status === 'pausada' ||
    !!run.retomada ||
    (run.status === 'falhou' && run.resultado === 'branch')
  );
}

export function canOpenMaestro(run: Run): boolean {
  return !!run.maestroSessionId && (ACTIVE.has(run.status) || canResumeRun(run));
}

/** Mantém os sufixos para os menus, inclusive o de PR que precisa ficar no fim. */
export function runContext(run: Run): string {
  return `fakl.run.${run.status}${canResumeRun(run) ? '.retomavel' : ''}${run.retomada ? '.limite' : ''}${run.retomada?.automatica ? '.auto' : ''}${run.prUrl ? '.pr' : ''}`;
}

/** Estado da tarefa como aparece na árvore; em pt-BR, o próprio valor do protocolo. */
export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'nova':
      return l10n.t('new');
    case 'executando':
      return l10n.t('running');
    case 'pausada':
      return l10n.t('paused');
    case 'concluída':
      return l10n.t('done');
    case 'falhou':
      return l10n.t('failed');
    case 'cancelada':
      return l10n.t('canceled');
  }
}

/** Estado da execução como aparece na árvore e nos avisos. */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'executando':
      return l10n.t('running');
    case 'pausada':
      return l10n.t('paused');
    case 'aguardando-decisão':
      return l10n.t('awaiting decision');
    case 'concluída':
      return l10n.t('done');
    case 'falhou':
      return l10n.t('failed');
    case 'descartada':
      return l10n.t('discarded');
  }
}

/** Como a execução terminou; merge, pr e branch são termos do git e ficam como estão. */
export function runResultLabel(resultado: NonNullable<Run['resultado']>): string {
  switch (resultado) {
    case 'rascunho':
      return l10n.t('draft');
    case 'descartado':
      return l10n.t('work discarded');
    default:
      return resultado;
  }
}

/** Linha curta ao lado da execução na árvore. */
export function runDescription(run: Run): string {
  const rodadas = run.rodadas.length;
  const agentes = run.agentes.length;
  const parts: string[] = [
    runStatusLabel(run.status),
    rodadas === 1 ? l10n.t('1 round') : l10n.t('{0} rounds', rodadas),
    agentes === 1 ? l10n.t('1 agent') : l10n.t('{0} agents', agentes),
  ];
  if (run.resultado) parts.push(runResultLabel(run.resultado));
  if (run.retomada) {
    parts.push(
      l10n.t('Session limit'),
      run.retomada.automatica ? l10n.t('Automatic resume') : l10n.t('Manual resume'),
    );
  }
  return parts.join(' · ');
}
