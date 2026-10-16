import { formatTokens } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import type { AgentSessionInfo } from '@fakl/protocol';

import { app } from '../app.js';
import { h, sheet, toast } from '../dom.js';
import { claudeAccountChoices, type ClaudeAccountChoice } from '../model.js';
import { chip, section } from './parts.js';

/**
 * Troca da conta do Claude pelo celular (ADR 0028): a mesma ação da IDE, para
 * quando uma assinatura bate o limite longe do computador. Login e saída
 * continuam só na IDE, que abre o terminal do CLI.
 */

/** Seção da tela de uso; sem contas configuradas na IDE, nada. */
export function claudeAccountsSection(): HTMLElement | false {
  const choices = claudeAccountChoices(app.claude, app.agents, usesClaudeAccount);
  if (choices.length === 0) return false;
  const command = app.can('comandar');
  return section(
    l10n.t('Claude accounts'),
    undefined,
    h(
      'ul',
      { class: 'contextos contas' },
      ...choices.map((choice) => {
        const body = h(
          'span',
          { class: 'cartao-corpo' },
          h('span', { class: 'cartao-nome' }, choice.nome),
          choice.ativa
            ? chip(l10n.t('Active account'), 'marca')
            : !choice.logada && chip(l10n.t('Not signed in'), 'ruim'),
          h('span', { class: 'meta' }, describe(choice)),
        );
        return h(
          'li',
          { class: choice.ativa ? 'ativa' : '' },
          command
            ? h(
                'button',
                {
                  class: 'cartao-toque',
                  type: 'button',
                  onclick: () => void switchTo(choice),
                },
                body,
              )
            : h('div', { class: 'cartao-toque' }, body),
        );
      }),
    ),
    h(
      'p',
      { class: 'dica' },
      command
        ? l10n.t(
            'The active account applies to new Claude agents; open ones switch to it when their turn ends, without losing the conversation.',
          )
        : l10n.t("This device can't command the IDE."),
    ),
  );
}

/**
 * Folha com as contas, aberta do menu da conversa. Pede a lista de novo: um
 * login ou apelido feito na IDE não avisa o celular.
 */
export async function openClaudeAccounts(): Promise<void> {
  await app.refreshClaude();
  const choices = claudeAccountChoices(app.claude, app.agents, usesClaudeAccount);
  if (choices.length === 0) {
    toast(l10n.t('No Claude account in the IDE.'), 'erro');
    return;
  }
  sheet(
    l10n.t('Claude account'),
    choices.map((choice) => ({
      label: choice.nome,
      description: describe(choice),
      icon: 'chave',
      checked: choice.ativa,
      run: () => void switchTo(choice),
    })),
  );
}

/** O agente roda o Claude Code com as contas da IDE (perfil anthropic com ACP). */
export function usesClaudeAccount(agent: AgentSessionInfo): boolean {
  if (agent.contaClaude) return true;
  const profile = app.profiles.find((entry) => entry.profile.id === agent.profileId)?.profile;
  return profile?.provedor === 'anthropic' && profile.adaptador === 'acp';
}

async function switchTo(choice: ClaudeAccountChoice): Promise<void> {
  if (choice.ativa) return;
  if (!choice.logada) {
    toast(l10n.t('{0} is not signed in. Sign in to it from the IDE.', choice.nome), 'erro');
    return;
  }
  const question = choice.semStatus
    ? l10n.t(
        "Use {0}? The active account applies to new Claude agents; open ones switch to it when their turn ends, without losing the conversation. Its sign-in can't be checked from here: if the computer isn't signed in to Claude Code, the agents stop.",
        choice.nome,
      )
    : l10n.t(
        'Use {0}? The active account applies to new Claude agents; open ones switch to it when their turn ends, without losing the conversation.',
        choice.nome,
      );
  if (!confirm(question)) return;
  if (await app.setClaudeAccount(choice.slot)) {
    toast(l10n.t('Claude account: {0}.', choice.nome));
  }
}

function describe(choice: ClaudeAccountChoice): string {
  return [
    choice.email,
    choice.plano,
    !choice.logada && l10n.t('not signed in; sign in from the IDE'),
    choice.tokensHoje > 0 && l10n.t('{0} tok today', formatTokens(choice.tokensHoje)),
    choice.agentes > 0 &&
      (choice.agentes === 1 ? l10n.t('1 agent') : l10n.t('{0} agents', choice.agentes)),
    choice.slot === null && l10n.t("the one in the computer's ~/.claude"),
  ]
    .filter(Boolean)
    .join(' · ');
}
