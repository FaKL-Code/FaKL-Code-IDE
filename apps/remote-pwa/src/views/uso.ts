import {
  contextShare,
  formatCost,
  formatTokens,
  PROVIDER_NAMES,
  usageBreakdown,
} from '@fakl/conversa';
import { currentLocale, l10n } from '@fakl/i18n';
import { isFinalAgentState } from '@fakl/protocol';

import { app } from '../app.js';
import { h, patch, ring } from '../dom.js';
import { providerUsage } from '../model.js';
import { claudeAccountsSection } from './contas.js';
import { avatar, empty, section, stateChip, type View } from './parts.js';

/**
 * Uso e limites: o gasto de hoje contra o teto de cada provedor, as contas do
 * Claude (com a troca, para quando uma bate o limite) e quanto do contexto
 * cada agente vivo já ocupou.
 */
export function usageView(): View {
  const el = h('div', { class: 'tela uso' });
  const update = (): void => {
    const summary = app.usage;
    if (!summary) {
      el.replaceChildren(
        empty(app.session ? l10n.t('Loading usage…') : l10n.t('No connection to the IDE.')),
      );
      return;
    }
    const tokens = summary.total.tokensEntrada + summary.total.tokensSaida;
    const providers = providerUsage(summary);
    const live = app.agents.filter((a) => !isFinalAgentState(a.state));
    patch(
      el,
      h(
        'div',
        { class: 'cartao destaque' },
        h('p', { class: 'meta' }, l10n.t('Today, {0}', formatDay(summary.dia))),
        h(
          'p',
          { class: 'numero' },
          l10n.t('{0} tokens', formatTokens(tokens)),
          summary.total.custoUsd > 0 &&
            h('small', {}, ' · ', l10n.t('${0}', summary.total.custoUsd.toFixed(2))),
        ),
        h(
          'p',
          { class: 'meta' },
          l10n.t(
            '{0} input · {1} output',
            formatTokens(summary.total.tokensEntrada),
            formatTokens(summary.total.tokensSaida),
          ),
        ),
      ),
      section(
        l10n.t('Daily limits'),
        undefined,
        providers.length === 0
          ? h('p', { class: 'meta' }, l10n.t('No spending today.'))
          : h(
              'ul',
              { class: 'limites' },
              ...providers.map((r) =>
                h(
                  'li',
                  { class: r.bloqueado ? 'bloqueado' : '' },
                  ring(r.bloqueado ? 1 : r.fracao, { size: 56 }),
                  h(
                    'div',
                    { class: 'limite-texto' },
                    h('span', { class: 'limite-nome' }, PROVIDER_NAMES[r.provedor] ?? r.provedor),
                    h(
                      'span',
                      { class: 'meta' },
                      r.bloqueado
                        ? r.teto
                          ? l10n.t('At the cap: {0} of {1}. The agents paused.', r.gasto, r.teto)
                          : l10n.t('At the cap: {0}. The agents paused.', r.gasto)
                        : r.teto
                          ? l10n.t('{0} of {1}', r.gasto, r.teto)
                          : l10n.t('{0} · no cap', r.gasto),
                    ),
                  ),
                ),
              ),
            ),
        Object.keys(summary.tetos).length === 0 &&
          h(
            'p',
            { class: 'dica' },
            l10n.t(
              "No caps set. In the IDE, set tetoDiario in config.yaml to pause a provider's agents when they reach the daily limit.",
            ),
          ),
      ),
      claudeAccountsSection(),
      section(
        l10n.t('Agent context'),
        live.length,
        live.length === 0
          ? h('p', { class: 'meta' }, l10n.t('No live agents.'))
          : h(
              'ul',
              { class: 'contextos' },
              ...live.map((agent) => {
                const share = contextShare(agent.usage);
                const usage = usageBreakdown(agent.usage);
                const context = agent.usage.context;
                const cost = formatCost(agent.usage.cost);
                return h(
                  'li',
                  { 'data-sessao': agent.sessionId },
                  h(
                    'button',
                    {
                      class: 'cartao-toque',
                      type: 'button',
                      onclick: () => {
                        app.go({ name: 'conversa', sessionId: agent.sessionId });
                      },
                    },
                    avatar(agent, 32),
                    h(
                      'span',
                      { class: 'cartao-corpo' },
                      h('span', { class: 'cartao-nome' }, agent.nome),
                      stateChip(agent),
                      h(
                        'span',
                        { class: 'meta' },
                        [
                          context
                            ? l10n.t(
                                'context {0} of {1}',
                                formatTokens(context.used),
                                formatTokens(context.size),
                              )
                            : l10n.t('context not reported'),
                          usage.total > 0 ? `${formatTokens(usage.total)} tok` : '',
                          cost,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      ),
                    ),
                    ring(share, { size: 44 }),
                  ),
                );
              }),
            ),
      ),
    );
  };
  update();
  // A lista de contas não chega por evento quando muda o login na IDE: pede ao abrir.
  void app.refreshClaude().then(() => {
    app.changed();
  });
  return { el, update };
}

function formatDay(dia: string): string {
  const [year, month, day] = dia.split('-');
  if (!year || !month || !day) return dia;
  return currentLocale() === 'pt-br' ? `${day}/${month}` : `${month}/${day}`;
}
