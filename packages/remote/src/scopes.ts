/** Escopos de um aparelho (SDD 12.3). */
export const REMOTE_SCOPES = ['ver', 'decidir', 'comandar', 'editor'] as const;

export type RemoteScope = (typeof REMOTE_SCOPES)[number];

/** O celular recebe estes por padrão; `editor` é opcional por aparelho. */
export const DEFAULT_SCOPES: readonly RemoteScope[] = ['ver', 'decidir', 'comandar'];

const METHODS: Record<RemoteScope, readonly string[]> = {
  ver: [
    'events.subscribe',
    'events.unsubscribe',
    'events.replay',
    'agents.list',
    'agents.transcript',
    'agents.diff',
    'agents.fileContent',
    'profiles.list',
    'tasks.list',
    'tasks.get',
    'runs.get',
    'runs.tree',
    'runs.decisions',
    'agents.permissions',
    'costs.summary',
    'claude.accounts.list',
    'playbooks.list',
    'cafe.open',
    'cafe.close',
    'cafe.state',
    'remote.push.subscribe',
    'remote.push.unsubscribe',
    'voz.status',
  ],
  decidir: ['runs.decide', 'agents.permission'],
  comandar: [
    'tasks.create',
    'tasks.cancel',
    'runs.start',
    'runs.pause',
    'runs.resume',
    'runs.setAutoResume',
    'runs.stop',
    'agents.start',
    'agents.send',
    'agents.pause',
    'agents.resume',
    'agents.setAutoResume',
    'agents.stop',
    'agents.setPermissions',
    'agents.setOption',
    // Trocar a conta do Claude de longe, quando uma bate o limite (ADR 0028).
    'claude.accounts.setActive',
    'playbooks.run',
    // Falar o pedido em vez de digitar (ADR 0031).
    'voz.transcrever',
  ],
  editor: [],
};

export function isRemoteScope(value: unknown): value is RemoteScope {
  return typeof value === 'string' && (REMOTE_SCOPES as readonly string[]).includes(value);
}

/** Métodos do Core que um aparelho com estes escopos pode chamar. */
export function methodsForScopes(scopes: readonly RemoteScope[]): Set<string> {
  return new Set(scopes.flatMap((scope) => METHODS[scope]));
}
