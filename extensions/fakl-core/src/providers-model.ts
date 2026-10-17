/**
 * Provedores de IA na IDE (ADR 0035): textos e validação dos comandos de
 * chave de API e de agentes ACP. Funções puras, sem VS Code.
 */

import { l10n } from '@fakl/i18n';
import {
  CLI_PROVIDERS,
  PROVIDER_KEY_ENV,
  providerName,
  type ProviderStatus,
  type ProviderUpdate,
} from '@fakl/protocol';

/** Provedor que aceita chave de API: os três com CLI e os agentes ACP que declararam a variável. */
export interface KeyTarget {
  readonly id: string;
  readonly nome: string;
  readonly variavel: string;
}

export function keyTargets(statuses: readonly ProviderStatus[] = []): KeyTarget[] {
  const fixed = CLI_PROVIDERS.map((id) => ({
    id,
    nome: providerName(id),
    variavel: PROVIDER_KEY_ENV[id],
  }));
  const acp = statuses
    .filter((status) => status.tipo === 'acp' && status.chaveEnv)
    .map((status) => ({ id: status.id, nome: status.nome, variavel: status.chaveEnv ?? '' }));
  return [...fixed, ...acp];
}

/** `NOME=valor; OUTRO=valor` (ou um por linha) em variáveis; erro em texto quando algo não serve. */
export function parseEnvPairs(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const raw of text.split(/[;\n]/)) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return l10n.t('"{0}" is not NAME=value', pair);
    env[name] = pair.slice(eq + 1).trim();
  }
  return env;
}

/** Argumentos separados por espaço; aspas agrupam (`--flag "com espaço"`). */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

function modeLabels(): Readonly<Record<string, string>> {
  return {
    assinatura: l10n.t('subscription'),
    chave: l10n.t('API key'),
    local: l10n.t('local model'),
    acp: l10n.t('ACP agent'),
  };
}

/** Linha de um provedor na lista: o que está pronto, como, e o que falta. */
export function statusLine(status: ProviderStatus): {
  label: string;
  description: string;
  detail: string;
} {
  const icon = status.pronto
    ? '$(pass-filled)'
    : status.instalado
      ? '$(warning)'
      : '$(circle-large-outline)';
  const parts = [
    status.pronto
      ? l10n.t('ready via {0}', modeLabels()[status.modo ?? ''] ?? status.modo ?? '')
      : l10n.t('not ready'),
    ...(status.versao ? [`v${status.versao}`] : []),
    ...(outdated(status).length > 0 ? [l10n.t('update available')] : []),
    ...(status.perfis.length > 0 ? [l10n.t('profiles: {0}', status.perfis.join(', '))] : []),
  ];
  return {
    label: `${icon} ${status.nome}`,
    description: parts.join(' · '),
    detail:
      status.aviso ??
      (outdated(status).length > 0
        ? outdated(status)
            .map((item) => `${item.comando} ${item.instalada} → ${item.ultima}`)
            .join(' · ')
        : undefined) ??
      (status.modelos?.length ? l10n.t('models: {0}', status.modelos.join(', ')) : ''),
  };
}

/** Pacotes do provedor com versão publicada mais nova que a instalada. */
export function outdated(status: ProviderStatus): ProviderUpdate[] {
  return (status.atualizacoes ?? []).filter((item) => item.desatualizada);
}

/** Comandos de terminal que resolvem o que falta (instalar, depois login). */
export function fixCommands(status: ProviderStatus): string[] {
  if (status.pronto) return [];
  const commands: string[] = [];
  // Instruções para servidores locais são texto para ler, não comandos.
  if (status.instalar && status.tipo !== 'local') commands.push(status.instalar);
  if (status.instalado && status.login && !status.chave) commands.push(status.login);
  return commands;
}
