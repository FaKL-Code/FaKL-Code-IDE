import { l10n } from '@fakl/i18n';

import { app } from '../app.js';
import { h, patch } from '../dom.js';
import { ago } from '../model.js';
import { avatar, empty, permissionPrompt, section, type View } from './parts.js';

/** Tudo que espera você: pedidos de permissão dos agentes e decisões das execuções. */
export function inboxView(): View {
  const el = h('div', { class: 'tela caixa' });
  const update = (): void => {
    if (app.pending === 0) {
      el.replaceChildren(
        empty(
          l10n.t('Nothing waiting for you.'),
          l10n.t('Turn on notifications in Settings to know right away.'),
        ),
      );
      return;
    }
    const permissions = app.permissions.map((request) => {
      const agent = app.agent(request.sessionId);
      return h(
        'article',
        { class: 'cartao' },
        h(
          'button',
          {
            class: 'cartao-cabeca link',
            type: 'button',
            onclick: () => {
              app.go({ name: 'conversa', sessionId: request.sessionId });
            },
          },
          agent && avatar(agent, 28),
          h('span', {}, agent?.nome ?? l10n.t('Agent')),
          h('span', { class: 'meta' }, l10n.t('asks for permission')),
        ),
        permissionPrompt(request),
      );
    });
    const decisions = app.decisions.map((decision) => {
      const task = app.tasks.find((t) => t.runs.includes(decision.runId));
      return h(
        'article',
        { class: 'cartao', 'data-decisao': decision.id },
        h(
          'button',
          {
            class: 'cartao-cabeca link',
            type: 'button',
            disabled: !task,
            onclick: () => {
              if (task) app.go({ name: 'tarefa', taskId: task.id });
            },
          },
          h('span', {}, task?.titulo ?? l10n.t('Run')),
          h('span', { class: 'meta' }, ago(decision.criadaEm)),
        ),
        h('p', { class: 'pergunta' }, decision.pergunta),
        app.can('decidir')
          ? h(
              'div',
              { class: 'opcoes' },
              ...decision.opcoes.map((option, index) =>
                h(
                  'button',
                  {
                    class: index === 0 ? 'primario' : '',
                    type: 'button',
                    onclick: () =>
                      void app
                        .call('runs.decide', {
                          runId: decision.runId,
                          decisionId: decision.id,
                          escolha: option.id,
                          origem: 'remoto',
                        })
                        .then((result) => {
                          if (result === undefined) return;
                          app.decisions = app.decisions.filter((d) => d.id !== decision.id);
                          app.changed();
                        }),
                  },
                  option.rotulo,
                ),
              ),
            )
          : h('p', { class: 'meta' }, l10n.t("This device can't make decisions.")),
      );
    });
    patch(
      el,
      permissions.length > 0
        ? section(l10n.t('Permissions'), permissions.length, ...permissions)
        : false,
      decisions.length > 0 ? section(l10n.t('Decisions'), decisions.length, ...decisions) : false,
    );
  };
  update();
  return { el, update };
}
