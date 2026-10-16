import { contextShare, formatCost, formatTokens, initials, lastLine } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import type { AgentPermissionRequest, AgentSessionInfo } from '@fakl/protocol';

import { app } from '../app.js';
import { h, icon, ring, type Child } from '../dom.js';
import { agentColor, ago, folderName, stateLabel, stateTone, type Tone } from '../model.js';

/** Uma tela do app. A casca monta o `el` uma vez e chama `update` quando os dados mudam. */
export interface View {
  readonly el: HTMLElement;
  /** Título no topo; sem ele, o nome da máquina. */
  title?(): string;
  subtitle?(): string;
  /** Botões à direita do topo. */
  actions?(): Child[];
  update(): void;
  dispose?(): void;
  /** Sem a barra de abas (a conversa tem o compositor embaixo). */
  readonly fullscreen?: boolean;
}

export function chip(text: string, tone: Tone | 'marca' = 'neutro'): HTMLElement {
  return h('span', { class: `chip ${tone}` }, text);
}

export function stateChip(agent: AgentSessionInfo): HTMLElement {
  const tone = stateTone(agent.state);
  return h(
    'span',
    { class: `estado ${tone}` },
    h('span', { class: 'estado-ponto', 'aria-hidden': 'true' }),
    stateLabel(agent.state),
  );
}

export function avatar(agent: Pick<AgentSessionInfo, 'nome' | 'provedor'>, size = 38): HTMLElement {
  const element = h(
    'span',
    { class: 'avatar', 'aria-hidden': 'true', style: `--tam:${String(size)}px` },
    initials(agent.nome),
  );
  element.style.setProperty('--cor', agentColor(agent));
  return element;
}

export function empty(text: string, hint?: string): HTMLElement {
  return h('div', { class: 'vazio' }, h('p', {}, text), hint && h('p', { class: 'dica' }, hint));
}

export function section(title: string, count?: number, ...children: Child[]): HTMLElement {
  return h(
    'section',
    { class: 'secao' },
    h(
      'h2',
      { class: 'secao-titulo' },
      title,
      count !== undefined && h('span', { class: 'contagem' }, String(count)),
    ),
    ...children,
  );
}

/** Onde o agente trabalha: o branch do worktree, ou a pasta. */
export function where(agent: AgentSessionInfo): string {
  return agent.worktree ? agent.worktree.branch : folderName(agent.cwd);
}

/** O que o agente disse por último: ao vivo, ou o que o Core guardou. */
export function lastWords(agent: AgentSessionInfo): string {
  const live = app.live.get(agent.sessionId);
  return live ? lastLine(live) : (agent.ultimaFala ?? '');
}

/** Anel pequeno do contexto ocupado; sem informação, o total de tokens. */
export function usageBadge(agent: AgentSessionInfo): HTMLElement {
  const share = contextShare(agent.usage);
  if (share !== undefined) return ring(share, { size: 34 });
  const tokens = agent.usage.totalTokens;
  return h('span', { class: 'tokens' }, tokens > 0 ? formatTokens(tokens) : '');
}

/** Cartão de um agente nas listas. */
export function agentCard(
  agent: AgentSessionInfo,
  options: { compact?: boolean; permissions?: readonly AgentPermissionRequest[] } = {},
): HTMLElement {
  const words = options.compact ? '' : lastWords(agent);
  const task = agent.taskId ? app.tasks.find((t) => t.id === agent.taskId) : undefined;
  const cost = formatCost(agent.usage.cost);
  const meta = [
    where(agent),
    ago(agent.encerradaEm ?? agent.atividadeEm ?? agent.iniciadaEm),
    options.compact ? cost : '',
  ].filter(Boolean);
  const card = h(
    'article',
    {
      class: `cartao-agente ${stateTone(agent.state)}${options.compact ? ' compacto' : ''}`,
      'data-sessao': agent.sessionId,
    },
    h(
      'button',
      {
        class: 'cartao-toque',
        type: 'button',
        onclick: () => {
          app.go({ name: 'conversa', sessionId: agent.sessionId });
        },
      },
      avatar(agent, options.compact ? 32 : 40),
      h(
        'span',
        { class: 'cartao-corpo' },
        h(
          'span',
          { class: 'cartao-linha' },
          h('span', { class: 'cartao-nome' }, agent.nome),
          agent.permissoes === 'autopilot' && chip('autopilot', 'marca'),
          task && chip(l10n.t('task'), 'neutro'),
        ),
        h(
          'span',
          { class: 'cartao-linha' },
          stateChip(agent),
          h('span', { class: 'meta' }, meta.join(' · ')),
        ),
        words && h('span', { class: 'cartao-fala' }, words),
        task && !options.compact && h('span', { class: 'meta' }, task.titulo),
      ),
      !options.compact && usageBadge(agent),
    ),
    ...(options.permissions ?? []).map((request) => permissionPrompt(request)),
  );
  return card;
}

/** Pedido de permissão com os botões, nas listas e na caixa. */
export function permissionPrompt(request: AgentPermissionRequest): HTMLElement {
  const answer = (allow: boolean): void => {
    void app
      .call('agents.permission', { sessionId: request.sessionId, id: request.id, allow })
      .then((result) => {
        if (result === undefined) return;
        app.permissions = app.permissions.filter(
          (p) => !(p.sessionId === request.sessionId && p.id === request.id),
        );
        app.changed();
      });
  };
  return h(
    'div',
    { class: 'pedido', 'data-pedido': `${request.sessionId}/${request.id}` },
    h('p', { class: 'pedido-titulo' }, icon('escudo', 16), h('span', {}, request.title)),
    app.can('decidir')
      ? h(
          'div',
          { class: 'acoes' },
          h(
            'button',
            {
              class: 'primario',
              type: 'button',
              onclick: () => {
                answer(true);
              },
            },
            l10n.t('Allow'),
          ),
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                answer(false);
              },
            },
            l10n.t('Deny'),
          ),
        )
      : h('p', { class: 'meta' }, l10n.t("This device can't answer requests.")),
  );
}

/** Botão redondo de ícone. */
export function iconButton(
  name: Parameters<typeof icon>[0],
  label: string,
  onclick: () => void,
  extra = '',
): HTMLElement {
  return h(
    'button',
    { class: `botao-icone ${extra}`, type: 'button', 'aria-label': label, title: label, onclick },
    icon(name, 20),
  );
}
