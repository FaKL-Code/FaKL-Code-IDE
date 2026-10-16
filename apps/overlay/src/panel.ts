import { contextShare, formatTokens, lastLine, PROVIDER_NAMES, preview } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  type AgentSessionInfo,
  type RunStatus,
  type Task,
} from '@fakl/protocol';

import { conversationView } from './conversa.js';
import {
  h,
  icon,
  iconButton,
  inlineMarkdown,
  miniRing,
  patch,
  SLOT,
  withSlot,
  type Child,
} from './dom.js';
import {
  agentStateText,
  agentTitle,
  ago,
  claudeAccountChoices,
  family,
  groupTasks,
  latestRun,
  nextAccount,
  offersAlways,
  panelGroups,
  petStatus,
  providerUsage,
  stateTone,
  usageText,
  waitingFor,
  windowRows,
  waitingKey,
  type Waiting,
} from './model.js';
import { newConversationView } from './nova.js';
import type { Overlay, View } from './store.js';

/** Uma tela do painel: o elemento e como ela se atualiza. */
export interface Screen {
  readonly element: HTMLElement;
  update(): void;
  /** Para onde vai o foco ao abrir. */
  focus?(): void;
  dispose?(): void;
}

const viewKey = (view: View): string =>
  view.name === 'conversa' ? `conversa:${view.sessionId}` : view.name;

/**
 * A forma painel: cabeçalho com o resumo, a tela atual e o rodapé. As
 * seções se refazem a cada mudança só onde o resultado é outro.
 */
export function panelView(overlay: Overlay): {
  element: HTMLElement;
  update(): void;
  focus(): void;
} {
  const mark = h('span', { class: 'marca', 'aria-hidden': 'true' }, '>', h('span', {}, '_'));
  const summary = h('p', { class: 'resumo', id: 'resumo' });
  const body = h('div', { class: 'corpo' });
  const notice = h('p', { class: 'aviso', role: 'status', 'aria-live': 'polite', hidden: true });
  const footer = h('footer', { class: 'rodape' });

  const header = h(
    'header',
    { class: 'topo' },
    mark,
    h('div', { class: 'topo-texto' }, h('h1', {}, l10n.t('Agents')), summary),
    iconButton('mais', l10n.t('New conversation (Ctrl+Alt+Space)'), () => {
      overlay.open({ name: 'nova' });
    }),
    iconButton('recolher', l10n.t('Collapse to the pet (Esc)'), () => {
      overlay.collapse();
    }),
  );

  const element = h(
    'section',
    { class: 'painel', 'aria-labelledby': 'resumo' },
    header,
    body,
    notice,
    footer,
  );

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  overlay.onNotice((text, tone) => {
    notice.textContent = text;
    notice.dataset.tom = tone;
    notice.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.hidden = true;
    }, 4_000);
  });

  let screen: Screen | undefined;
  let shown = '';

  const update = (): void => {
    const status = petStatus(overlay.snapshot());
    element.dataset.anel = status.ring;
    summary.textContent =
      overlay.connection === 'offline'
        ? l10n.t('No connection to the Core')
        : !overlay.loaded
          ? l10n.t('Loading…')
          : status.label;

    const key = viewKey(overlay.view);
    if (key !== shown) {
      screen?.dispose?.();
      screen = build(overlay, overlay.view);
      shown = key;
      body.replaceChildren(screen.element);
      body.scrollTop = 0;
      if (overlay.mode === 'painel') screen.focus?.();
    }
    screen?.update();
    patch(footer, ...footerParts(overlay));
  };
  update();
  return {
    element,
    update,
    focus() {
      screen?.focus?.();
    },
  };
}

function build(overlay: Overlay, view: View): Screen {
  switch (view.name) {
    case 'conversa':
      return conversationView(overlay, view.sessionId);
    case 'nova':
      return newConversationView(overlay);
    case 'inicio':
      return homeView(overlay);
  }
}

// ---------------------------------------------------------------- início

function homeView(overlay: Overlay): Screen {
  const waiting = h('section', { class: 'secao espera', 'aria-label': l10n.t('Waiting for you') });
  const live = h('div', { class: 'lista' });
  // Os encerrados ficam recolhidos; o <details> não é refeito, então continua aberto ou fechado.
  const closed = h('details', { class: 'encerrados', hidden: true });
  const agents = h(
    'section',
    { class: 'secao', 'aria-labelledby': 'h-agentes' },
    h('h2', { id: 'h-agentes' }, l10n.t('Agents')),
    live,
    closed,
  );
  const tasks = h('section', { class: 'secao', 'aria-labelledby': 'h-tarefas' });
  const usage = h('section', { class: 'secao', 'aria-labelledby': 'h-uso' });

  // O foco começa na lista, não num botão: um Enter distraído não pode aprovar nada.
  const element = h(
    'div',
    { class: 'inicio', tabindex: '-1', 'aria-label': l10n.t('Agents and requests') },
    waiting,
    agents,
    tasks,
    usage,
  );
  element.addEventListener('keydown', (event) => {
    arrowNavigation(element, event);
  });

  return {
    element,
    focus() {
      element.focus({ preventScroll: true });
    },
    update() {
      const snapshot = overlay.snapshot();
      const items = waitingFor(snapshot, overlay.tasks);
      waiting.hidden = items.length === 0;
      patch(
        waiting,
        items.length > 0 &&
          h(
            'h2',
            {},
            l10n.t('Waiting for you'),
            h('span', { class: 'conta', 'aria-hidden': 'true' }, String(items.length)),
          ),
        ...items.map((item) => waitingItem(overlay, item)),
      );

      if (!overlay.loaded) {
        patch(live, h('p', { class: 'vazio' }, l10n.t('Loading agents…')));
        return;
      }

      const groups = panelGroups(overlay.agents);
      const row = (agent: AgentSessionInfo): HTMLElement =>
        agentRow(overlay, agent, snapshot.limited.has(agent.sessionId));
      const alive = groups.trabalhando.length + groups.ociosos.length;
      patch(
        live,
        alive === 0 &&
          h(
            'p',
            { class: 'vazio' },
            ...withSlot(
              l10n.t('No agents open. {0} and follow it from here.', SLOT),
              h(
                'button',
                {
                  type: 'button',
                  class: 'link',
                  'data-foco': 'nova',
                  onclick: () => {
                    overlay.open({ name: 'nova' });
                  },
                },
                l10n.t('Start a conversation'),
              ),
            ),
          ),
        groups.trabalhando.length > 0 && groupTitle(l10n.t('Working'), groups.trabalhando.length),
        ...groups.trabalhando.map(row),
        groups.ociosos.length > 0 && groupTitle(l10n.t('Idle agents'), groups.ociosos.length),
        ...groups.ociosos.map(row),
      );
      closed.hidden = groups.encerrados.length === 0;
      patch(
        closed,
        h('summary', { 'data-parada': true }, l10n.t('Ended ({0})', groups.encerrados.length)),
        ...groups.encerrados.slice(0, 20).map(row),
      );

      patch(tasks, ...taskParts(overlay));
      patch(usage, ...usageParts(overlay));
    },
  };
}

function groupTitle(label: string, count: number): HTMLElement {
  return h('h3', {}, label, h('span', { class: 'conta' }, String(count)));
}

/** Setas para cima e para baixo andam entre as linhas e os botões das seções. */
function arrowNavigation(root: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('textarea, select, input')) return;
  const stops = [...root.querySelectorAll<HTMLElement>('[data-parada]')].filter(
    (el) => el.offsetParent !== null,
  );
  const current = stops.indexOf(target.closest<HTMLElement>('[data-parada]') ?? target);
  const next = stops[current + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

// ---------------------------------------------------------------- esperando você

function waitingItem(overlay: Overlay, item: Waiting): HTMLElement {
  const key = waitingKey(item);
  switch (item.kind) {
    case 'permissao': {
      const { request, agent } = item;
      return h(
        'article',
        { class: 'pedido', 'data-tipo': 'permissao' },
        h(
          'p',
          { class: 'pedido-quem' },
          icon('escudo', 14),
          h('span', {}, l10n.t('{0} is asking for permission', agent?.nome ?? l10n.t('Agent'))),
          agent && h('span', { class: 'meta' }, agentTitle(agent)),
        ),
        h('p', { class: 'pedido-texto' }, inlineMarkdown(request.title)),
        request.detail && h('pre', { class: 'pedido-detalhe' }, request.detail),
        h(
          'div',
          { class: 'acoes' },
          h(
            'button',
            {
              type: 'button',
              class: 'primario',
              'data-foco': `${key}:sim`,
              'data-parada': true,
              onclick: () => void overlay.answerPermission(request, true),
            },
            l10n.t('Allow'),
          ),
          // Só quando o agente oferece (ACP `allow_always`): vale para os próximos pedidos iguais da sessão.
          offersAlways(request) &&
            h(
              'button',
              {
                type: 'button',
                'data-foco': `${key}:sempre`,
                onclick: () => void overlay.answerPermission(request, true, true),
              },
              l10n.t('Always allow in this session'),
            ),
          h(
            'button',
            {
              type: 'button',
              'data-foco': `${key}:nao`,
              onclick: () => void overlay.answerPermission(request, false),
            },
            l10n.t('Deny'),
          ),
        ),
      );
    }
    case 'decisao': {
      const { decision, task } = item;
      return h(
        'article',
        { class: 'pedido', 'data-tipo': 'decisao' },
        h(
          'p',
          { class: 'pedido-quem' },
          icon('pergunta', 14),
          h('span', {}, l10n.t('The maestro is asking for a decision')),
          task && h('span', { class: 'meta' }, task.titulo),
        ),
        h('p', { class: 'pedido-texto' }, decision.pergunta),
        h(
          'div',
          { class: 'acoes' },
          // A primeira opção é a recomendada pelo maestro.
          ...decision.opcoes.map((option, index) =>
            h(
              'button',
              {
                type: 'button',
                class: index === 0 ? 'primario' : '',
                'data-foco': `${key}:${option.id}`,
                'data-parada': index === 0,
                onclick: () => void overlay.decide(decision, option.id),
              },
              option.rotulo,
            ),
          ),
        ),
      );
    }
    case 'limite': {
      const { agent } = item;
      const isClaude = agent.contaClaude !== undefined || agent.provedor === 'anthropic';
      const target = isClaude
        ? nextAccount(claudeAccountChoices(overlay.claude, overlay.agents))
        : undefined;
      return h(
        'article',
        { class: 'pedido', 'data-tipo': 'limite' },
        h(
          'p',
          { class: 'pedido-quem' },
          icon('limite', 14),
          h('span', {}, l10n.t('{0} hit the limit', agent.nome)),
          h('span', { class: 'meta' }, agentTitle(agent)),
        ),
        h(
          'p',
          { class: 'pedido-texto' },
          overlay.limitReason(agent.sessionId) ??
            l10n.t('The provider refused because of a usage limit.'),
        ),
        h(
          'div',
          { class: 'acoes' },
          target &&
            h(
              'button',
              {
                type: 'button',
                class: 'primario',
                'data-foco': `${key}:trocar`,
                'data-parada': true,
                onclick: () =>
                  void overlay.setClaudeAccount(target.slot).then((ok) => {
                    if (!ok) return;
                    overlay.notice(l10n.t('Account switched to {0}.', target.nome));
                    void overlay.resume(agent);
                  }),
              },
              l10n.t('Switch to {0} and continue', target.nome),
            ),
          h(
            'button',
            {
              type: 'button',
              class: target ? '' : 'primario',
              'data-foco': `${key}:continuar`,
              'data-parada': !target,
              onclick: () => void overlay.resume(agent),
            },
            l10n.t('Continue'),
          ),
        ),
      );
    }
    case 'resposta': {
      const { agent } = item;
      return h(
        'article',
        { class: 'pedido', 'data-tipo': 'resposta' },
        h(
          'p',
          { class: 'pedido-quem' },
          icon('pergunta', 14),
          h('span', {}, l10n.t('{0} is waiting for your answer', agent.nome)),
          h('span', { class: 'meta' }, agentTitle(agent)),
        ),
        agent.ultimaFala && h('p', { class: 'pedido-texto' }, preview(agent.ultimaFala, 160)),
        h(
          'div',
          { class: 'acoes' },
          h(
            'button',
            {
              type: 'button',
              class: 'primario',
              'data-foco': `${key}:responder`,
              'data-parada': true,
              onclick: () => {
                overlay.open({ name: 'conversa', sessionId: agent.sessionId });
              },
            },
            l10n.t('Reply'),
          ),
        ),
      );
    }
  }
}

// ---------------------------------------------------------------- agentes

function agentRow(overlay: Overlay, agent: AgentSessionInfo, limited: boolean): HTMLElement {
  const id = agent.sessionId;
  const final = isFinalAgentState(agent.state);
  const words = overlay.live.get(id) ?? agent.ultimaFala;
  const share = contextShare(agent.usage);
  const tone = limited ? 'ruim' : stateTone(agent.state);
  const when = ago(agent.atividadeEm ?? agent.encerradaEm ?? agent.iniciadaEm);
  return h(
    'div',
    { class: 'agente', 'data-tom': tone, 'data-familia': family(agent) },
    h(
      'button',
      {
        type: 'button',
        class: 'agente-abrir',
        'data-foco': `a:${id}`,
        'data-parada': true,
        'aria-label': l10n.t(
          '{0}, {1}: {2}. Open the conversation.',
          agent.nome,
          agentTitle(agent),
          agentStateText(agent, limited),
        ),
        onclick: () => {
          overlay.open({ name: 'conversa', sessionId: id });
        },
      },
      h('span', { class: 'agente-ponto', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'agente-texto' },
        h(
          'span',
          { class: 'agente-nome' },
          h('strong', {}, agent.nome),
          h('span', {}, agentTitle(agent)),
        ),
        words && h('span', { class: 'agente-fala' }, lastLine(words, 90)),
        h(
          'span',
          { class: 'agente-estado' },
          agentStateText(agent, limited),
          when && h('span', { class: 'meta' }, when),
        ),
      ),
    ),
    h(
      'span',
      { class: 'agente-medidas' },
      share !== undefined && miniRing(share, l10n.t('Context {0}%', Math.round(share * 100))),
      h('span', { class: 'custo' }, usageText(agent)),
    ),
    !final &&
      h(
        'span',
        { class: 'agente-acoes' },
        stateTone(agent.state) === 'ativo' &&
          iconButton(
            'interromper',
            l10n.t('Interrupt {0}', agent.nome),
            () => void overlay.call('agents.pause', { sessionId: id }),
            { 'data-foco': `a:${id}:pausa` },
          ),
        agent.state === 'pausado' &&
          iconButton(
            'retomar',
            l10n.t('Resume {0}', agent.nome),
            () => void overlay.call('agents.resume', { sessionId: id }),
            { 'data-foco': `a:${id}:retomar` },
          ),
        iconButton(
          'parar',
          l10n.t('Stop {0}', agent.nome),
          () => void overlay.call('agents.stop', { sessionId: id }),
          { 'data-foco': `a:${id}:parar` },
        ),
        iconButton(
          'ide',
          l10n.t('Open {0} in the IDE', agent.nome),
          () => {
            overlay.reveal(id);
          },
          { 'data-foco': `a:${id}:ide` },
        ),
      ),
  );
}

// ---------------------------------------------------------------- tarefas

/** Estado da execução na linha da tarefa; um Core mais novo pode mandar um que não está aqui. */
function runLabel(status: RunStatus): string | undefined {
  switch (status) {
    case 'executando':
      return l10n.t('Ongoing');
    case 'pausada':
      return l10n.t('Paused');
    case 'aguardando-decisão':
      return l10n.t('Waiting for a decision');
    case 'concluída':
      return l10n.t('Complete');
    case 'falhou':
      return l10n.t('Failed');
    case 'descartada':
      return l10n.t('Discarded');
    default:
      return undefined;
  }
}

function taskParts(overlay: Overlay): Child[] {
  const { andamento, recentes } = groupTasks(overlay.tasks, overlay.runs);
  const shown = [...andamento, ...recentes.slice(0, Math.max(0, 3 - andamento.length))];
  if (shown.length === 0) return [];
  return [
    h('h2', { id: 'h-tarefas' }, l10n.t('Tasks')),
    ...shown.map((task) => taskRow(overlay, task)),
  ];
}

function taskRow(overlay: Overlay, task: Task): HTMLElement {
  const run = latestRun(task, overlay.runs);
  const round = run?.rodadas.at(-1);
  const status = run ? (runLabel(run.status) ?? run.status) : task.status;
  const maestro =
    run?.maestroSessionId ?? run?.agentes.find((a) => a.papel === 'maestro')?.sessionId;
  const helpers = run ? run.agentes.filter((a) => a.papel !== 'maestro').length : 0;
  const parts = [
    status,
    round &&
      (round.veredito
        ? l10n.t('round {0}, {1}', round.numero, round.veredito)
        : l10n.t('round {0}', round.numero)),
    helpers > 0 && (helpers === 1 ? l10n.t('1 subagent') : l10n.t('{0} subagents', helpers)),
  ].filter((part): part is string => typeof part === 'string' && part !== '');
  return h(
    'div',
    { class: 'tarefa', 'data-veredito': round?.veredito ?? '' },
    h(
      'span',
      { class: 'tarefa-texto' },
      h('strong', {}, task.titulo),
      h('span', { class: 'meta' }, parts.join(', ')),
    ),
    maestro &&
      iconButton(
        'ide',
        l10n.t('Open "{0}" in the IDE', task.titulo),
        () => {
          overlay.reveal(maestro);
        },
        { 'data-foco': `t:${task.id}`, 'data-parada': true },
      ),
  );
}

// ---------------------------------------------------------------- uso

function usageParts(overlay: Overlay): Child[] {
  const rings = providerUsage(overlay.usage);
  const accounts = claudeAccountChoices(overlay.claude, overlay.agents);
  const plans = windowRows(overlay.windows, Date.now());
  if (rings.length === 0 && accounts.length === 0 && plans.length === 0) return [];
  return [
    h('h2', { id: 'h-uso' }, l10n.t("Today's usage")),
    ...rings.map((ring) => {
      const meter = h('span', { class: 'medidor', 'aria-hidden': 'true' }, h('span', {}));
      const fill = meter.firstElementChild as HTMLElement;
      fill.style.setProperty('--fracao', String(ring.fracao ?? 0));
      return h(
        'div',
        {
          class: 'provedor',
          'data-estado': ring.bloqueado ? 'bloqueado' : (ring.fracao ?? 0) >= 0.8 ? 'perto' : '',
          'data-fracao': ring.fracao === undefined ? '' : ring.fracao.toFixed(3),
        },
        h(
          'span',
          { class: 'provedor-texto' },
          h('span', {}, PROVIDER_NAMES[ring.provedor] ?? ring.provedor),
          h(
            'span',
            { class: 'meta' },
            ring.bloqueado
              ? l10n.t('{0}, cap reached', ring.gasto)
              : ring.teto
                ? l10n.t('{0} of {1}', ring.gasto, ring.teto)
                : l10n.t('{0}, no cap', ring.gasto),
          ),
        ),
        ring.fracao !== undefined && meter,
      );
    }),
    plans.length > 0 && h('h3', {}, l10n.t('5h session and week')),
    ...plans.map((plan) =>
      h(
        'div',
        { class: 'provedor', 'data-origem': plan.origem },
        h(
          'span',
          { class: 'provedor-texto' },
          h('span', {}, plan.nome),
          ...plan.linhas.map((line) => {
            const meter = h('span', { class: 'medidor', 'aria-hidden': 'true' }, h('span', {}));
            if (line.fracao !== undefined) {
              (meter.firstElementChild as HTMLElement).style.setProperty(
                '--fracao',
                String(line.fracao),
              );
            }
            return h(
              'span',
              { class: 'meta' },
              line.zera
                ? l10n.t('{0}: {1}, resets in {2}', line.rotulo, line.valor, line.zera)
                : `${line.rotulo}: ${line.valor}`,
              line.fracao !== undefined && meter,
            );
          }),
          plan.origem === 'estimado' &&
            h('span', { class: 'meta' }, l10n.t('Estimated from local tokens')),
        ),
      ),
    ),
    accounts.length > 0 && h('h3', {}, l10n.t('Claude account')),
    ...accounts.map((account) =>
      h(
        'div',
        { class: 'conta-claude', 'data-ativa': account.ativa },
        h(
          'span',
          { class: 'provedor-texto' },
          h('span', {}, account.nome),
          h(
            'span',
            { class: 'meta' },
            [
              account.plano,
              account.tokensHoje > 0 && l10n.t('{0} tok today', formatTokens(account.tokensHoje)),
              account.agentes > 0 &&
                (account.agentes === 1 ? l10n.t('1 agent') : l10n.t('{0} agents', account.agentes)),
              !account.logada && l10n.t('not signed in'),
            ]
              .filter(Boolean)
              .join(', ') || account.email,
          ),
        ),
        account.ativa
          ? h('span', { class: 'selo-ativa' }, l10n.t('In use'))
          : h(
              'button',
              {
                type: 'button',
                'data-foco': `c:${String(account.slot)}`,
                'data-parada': true,
                disabled: !account.logada,
                onclick: () =>
                  void overlay.setClaudeAccount(account.slot).then((ok) => {
                    if (ok) overlay.notice(l10n.t('Claude agents now on {0}.', account.nome));
                  }),
              },
              icon('troca', 14),
              l10n.t('Use'),
            ),
      ),
    ),
  ];
}

// ---------------------------------------------------------------- rodapé

function footerParts(overlay: Overlay): Child[] {
  const { naoPerturbe, fixado } = overlay.prefs;
  const connection = overlay.connection;
  const label =
    connection === 'online'
      ? l10n.t('Connected to the Core')
      : connection === 'offline'
        ? l10n.t('No Core; reconnecting')
        : l10n.t('Connecting…');
  return [
    h('span', { class: 'conexao', 'data-estado': connection }, label),
    h(
      'button',
      {
        type: 'button',
        class: 'abrir-ide',
        'data-foco': 'f:ide',
        onclick: () => {
          overlay.reveal();
        },
      },
      icon('ide', 14),
      l10n.t('Open IDE'),
    ),
    iconButton(
      naoPerturbe ? 'silencio' : 'sino',
      naoPerturbe ? l10n.t('Do not disturb is on: bubbles are muted') : l10n.t('Do not disturb'),
      () => {
        overlay.setPref('naoPerturbe', !naoPerturbe);
      },
      { 'aria-pressed': naoPerturbe ? 'true' : 'false', 'data-foco': 'f:np' },
    ),
    iconButton(
      'fixar',
      fixado
        ? l10n.t("Panel pinned: it won't collapse when you click outside")
        : l10n.t('Pin the panel open'),
      () => {
        overlay.setPref('fixado', !fixado);
      },
      { 'aria-pressed': fixado ? 'true' : 'false', 'data-foco': 'f:fixar' },
    ),
    iconButton(
      'esconder',
      l10n.t('Hide the overlay (stays in the tray)'),
      () => {
        overlay.bridge.hide();
      },
      { 'data-foco': 'f:esconder' },
    ),
    iconButton(
      'sair',
      l10n.t('Quit FaKL-Code'),
      () => {
        overlay.bridge.quit();
      },
      { 'data-foco': 'f:sair' },
    ),
  ];
}
