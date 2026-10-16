import { l10n } from '@fakl/i18n';
import type { GhNotification, GhOrg, GhRepo } from '@fakl/integrations';

/** Filtro de status das Actions da conta, na ordem do menu. */
export const RUN_FILTERS = [
  { id: 'todas', status: undefined },
  { id: 'falhou', status: 'failure' },
  { id: 'andamento', status: 'in_progress' },
  { id: 'sucesso', status: 'success' },
] as const;

export type RunFilterId = (typeof RUN_FILTERS)[number]['id'];

/** Rótulo de um filtro de status das Actions, no idioma atual. */
export function runFilterLabel(id: RunFilterId): string {
  switch (id) {
    case 'todas':
      return l10n.t('All');
    case 'falhou':
      return l10n.t('Failed');
    case 'andamento':
      return l10n.t('In progress');
    case 'sucesso':
      return l10n.t('Succeeded');
  }
}

/** Quem é dono de um grupo de repositórios na raiz Conta. */
export interface OwnerGroup {
  readonly login: string;
  readonly kind: 'user' | 'org' | 'colab';
  /** Repositórios já conhecidos deste dono (a lista da conta); orgs são completadas ao expandir. */
  readonly repos: readonly GhRepo[];
}

/**
 * Agrupa os repositórios da conta por dono: o usuário primeiro, depois as
 * organizações (mesmo as sem repositório recente) e, por fim, o que vem de
 * colaboração em contas de terceiros.
 */
export function groupByOwner(
  user: string | undefined,
  orgs: readonly GhOrg[],
  repos: readonly GhRepo[],
): OwnerGroup[] {
  const ownerOf = (repo: GhRepo): string => repo.owner?.login ?? repo.full_name.split('/')[0] ?? '';
  const lower = (value: string): string => value.toLowerCase();
  const orgLogins = new Set(orgs.map((org) => lower(org.login)));
  const groups: OwnerGroup[] = [];
  if (user) {
    groups.push({
      login: user,
      kind: 'user',
      repos: repos.filter((repo) => lower(ownerOf(repo)) === lower(user)),
    });
  }
  for (const org of orgs) {
    groups.push({
      login: org.login,
      kind: 'org',
      repos: repos.filter((repo) => lower(ownerOf(repo)) === lower(org.login)),
    });
  }
  const colab = repos.filter(
    (repo) => lower(ownerOf(repo)) !== lower(user ?? '') && !orgLogins.has(lower(ownerOf(repo))),
  );
  if (colab.length > 0)
    groups.push({ login: l10n.t('Collaborations'), kind: 'colab', repos: colab });
  return groups;
}

/** Repositórios cujo nome ou descrição contém o texto (sem diferenciar maiúsculas). */
export function filterRepos(repos: readonly GhRepo[], text: string): GhRepo[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...repos];
  return repos.filter(
    (repo) =>
      repo.full_name.toLowerCase().includes(needle) ||
      (repo.description ?? '').toLowerCase().includes(needle),
  );
}

export interface NotificationGroup {
  readonly repo: string;
  readonly unread: number;
  readonly items: readonly GhNotification[];
}

/** Notificações agrupadas por repositório; os grupos com novidade mais recente vêm primeiro. */
export function groupNotifications(list: readonly GhNotification[]): NotificationGroup[] {
  const byRepo = new Map<string, GhNotification[]>();
  for (const notification of list) {
    const key = notification.repository.full_name;
    const items = byRepo.get(key);
    if (items) items.push(notification);
    else byRepo.set(key, [notification]);
  }
  const newest = (items: readonly GhNotification[]): number =>
    Math.max(...items.map((item) => Date.parse(item.updated_at) || 0));
  return [...byRepo.entries()]
    .map(([repo, items]) => ({
      repo,
      unread: items.filter((item) => item.unread).length,
      items: [...items].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    }))
    .sort((a, b) => newest(b.items) - newest(a.items));
}

/** Quantas notificações não lidas há no total. */
export function unreadCount(list: readonly GhNotification[]): number {
  return list.filter((item) => item.unread).length;
}

/** Resumo de erros por repositório do agregador de Actions, em uma linha. */
export function summarizeRunErrors(
  errors: readonly { readonly repo: string; readonly message: string }[],
): string | undefined {
  if (errors.length === 0) return undefined;
  const sso = errors.filter((error) => error.message.includes('SSO')).length;
  const total = errors.length;
  if (total === 1) {
    return sso > 0
      ? l10n.t('1 repository could not be read (it needs SSO authorization)')
      : l10n.t('1 repository could not be read');
  }
  if (sso === 0) return l10n.t('{0} repositories could not be read', String(total));
  return sso === 1
    ? l10n.t('{0} repositories could not be read (1 needs SSO authorization)', String(total))
    : l10n.t(
        '{0} repositories could not be read ({1} need SSO authorization)',
        String(total),
        String(sso),
      );
}
