import { l10n } from '@fakl/i18n';

import { app } from '../app.js';
import { h, icon, patch } from '../dom.js';
import { groupAgents, isWorking } from '../model.js';
import { agentCard, empty, section, type View } from './parts.js';

/** Encerrados mostrados antes do "mostrar todos". */
const ENDED_PAGE = 15;

/** Estado da lista entre atualizações. */
const memory = { endedOpen: false, endedAll: false };

/**
 * Os agentes: quem espera você no topo, os vivos em seguida e os encerrados
 * recolhidos embaixo, para não se misturarem com quem está rodando.
 */
export function agentsView(): View {
  const el = h('div', { class: 'tela agentes' });

  const update = (): void => {
    if (!app.loaded) {
      el.replaceChildren(empty(l10n.t('Loading agents…')));
      return;
    }
    const pending = new Set(app.permissions.map((p) => p.sessionId));
    const groups = groupAgents(app.agents, pending);
    const working = groups.ativos.filter((a) => isWorking(a.state)).length;
    const children: Node[] = [];

    children.push(
      h(
        'div',
        { class: 'resumo' },
        h(
          'p',
          { class: 'resumo-texto' },
          summary(working, groups.atencao.length, groups.ativos.length - working),
        ),
        app.can('comandar') &&
          h(
            'button',
            {
              class: 'primario pequeno',
              type: 'button',
              onclick: () => {
                app.go({ name: 'nova-conversa' });
              },
            },
            icon('mais', 16),
            l10n.t('New conversation'),
          ),
      ),
    );

    if (groups.atencao.length > 0) {
      children.push(
        section(
          l10n.t('Waiting for you'),
          groups.atencao.length,
          ...groups.atencao.map((agent) =>
            agentCard(agent, {
              permissions: app.permissions.filter((p) => p.sessionId === agent.sessionId),
            }),
          ),
        ),
      );
    }

    if (groups.ativos.length > 0) {
      children.push(
        section(l10n.t('Active'), groups.ativos.length, ...groups.ativos.map((a) => agentCard(a))),
      );
    } else if (groups.atencao.length === 0) {
      children.push(
        empty(
          l10n.t('No agents running right now.'),
          app.can('comandar')
            ? l10n.t('Start a conversation or create a task for the maestro.')
            : l10n.t('Agents you open in the IDE show up here.'),
        ),
      );
    }

    if (groups.encerrados.length > 0) {
      const shown = memory.endedAll ? groups.encerrados : groups.encerrados.slice(0, ENDED_PAGE);
      const details = h(
        'details',
        { class: 'encerrados', open: memory.endedOpen },
        h(
          'summary',
          {},
          h('span', {}, l10n.t('Ended')),
          h('span', { class: 'contagem' }, String(groups.encerrados.length)),
        ),
        ...shown.map((agent) => agentCard(agent, { compact: true })),
        shown.length < groups.encerrados.length &&
          h(
            'button',
            {
              class: 'link',
              type: 'button',
              onclick: () => {
                memory.endedAll = true;
                update();
              },
            },
            l10n.t('Show all ({0})', groups.encerrados.length),
          ),
      );
      details.addEventListener('toggle', () => {
        memory.endedOpen = details.open;
      });
      children.push(details);
    }
    patch(el, ...children);
  };

  update();
  return { el, update };
}

function summary(working: number, waiting: number, idle: number): string {
  const parts: string[] = [];
  if (working > 0) parts.push(l10n.t('{0} working', working));
  if (waiting > 0) parts.push(l10n.t('{0} waiting for you', waiting));
  if (idle > 0) parts.push(idle === 1 ? l10n.t('1 idle') : l10n.t('{0} idle', idle));
  return parts.length > 0 ? parts.join(' · ') : l10n.t('All quiet');
}
