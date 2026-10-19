import { l10n } from '@fakl/i18n';
import type { CiStatus } from '@fakl/protocol';

/*
 * Café do CI na IDE (ADR 0051), partes puras: o item da barra de status e a
 * lista de repositórios para escolher. Sem VS Code.
 */

/** Configuração `fakl.ci.repositorios`, sem o prefixo `fakl.`. */
export const WATCHED_SETTING = 'ci.repositorios';

export interface StatusBarView {
  readonly visible: boolean;
  readonly text: string;
  readonly tooltip: string;
  /** Há execução falhando: o item ganha a cor de aviso. */
  readonly warn: boolean;
}

/** Item da barra de status: o número de fluxos falhando; some sem repositório acompanhado. */
export function statusBarView(status: CiStatus | undefined): StatusBarView {
  if (!status || status.repos.length === 0) {
    return { visible: false, text: '', tooltip: '', warn: false };
  }
  const failing = status.falhando;
  const repos = status.repos.map((r) => r.repo).join(', ');
  const lines = [
    failing === 0 ? l10n.t('CI: nothing failing') : l10n.t('CI: {0} failing', String(failing)),
    l10n.t(
      '{0} running, {1} green in a row',
      String(status.trabalhando),
      String(status.verdesSeguidos),
    ),
    repos,
  ];
  if (!status.conectado) lines.push(l10n.t('Sign in to GitHub to follow the CI.'));
  else if (!status.automatico)
    lines.push(l10n.t('Automatic queries are off: use "Refresh CI now".'));
  return {
    visible: true,
    text: failing === 0 ? '$(check) CI' : `$(error) ${String(failing)}`,
    tooltip: lines.join('\n'),
    warn: failing > 0,
  };
}

/**
 * Repositórios para o seletor: os já acompanhados primeiro, depois os da
 * conta, sem repetir (sem olhar maiúsculas) e sem passar de `max`.
 */
export function repoChoices(
  watched: readonly string[],
  account: readonly string[],
  max = 100,
): { repo: string; picked: boolean }[] {
  const seen = new Set<string>();
  const out: { repo: string; picked: boolean }[] = [];
  const add = (repo: string, picked: boolean): void => {
    const key = repo.toLowerCase();
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ repo, picked });
  };
  for (const repo of watched) add(repo, true);
  for (const repo of account) add(repo, false);
  return out;
}

/** Valor digitado na caixa de texto: `dono/nome` ou um endereço do github.com. */
export function parseRepoInput(value: string): string | undefined {
  const text = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[\w.-]{1,100}$/.test(text) ? text : undefined;
}
