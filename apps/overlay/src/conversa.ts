import { contextShare } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  PERMISSION_MODES,
  type AgentSessionInfo,
  type PermissionPolicyName,
} from '@fakl/protocol';

import {
  h,
  icon,
  iconButton,
  inlineMarkdown,
  markdown,
  miniRing,
  patch,
  type Child,
} from './dom.js';
import {
  agentStateText,
  agentTitle,
  canSend,
  compactTranscript,
  family,
  stateTone,
  stepsLabel,
  usageText,
  type CompactItem,
} from './model.js';
import type { Screen } from './panel.js';
import type { Overlay } from './store.js';

/** Nome do modo de permissão na tela; função para o texto sair no idioma escolhido. */
export function modeLabel(mode: PermissionPolicyName): string {
  switch (mode) {
    case 'perguntar':
      return l10n.t('Ask');
    case 'aprovar-leitura':
      return l10n.t('Approve reads');
    case 'aprovar-tudo':
      return l10n.t('Approve all');
    case 'autopilot':
      return l10n.t('Autopilot');
  }
}

/**
 * Conversa compacta com um agente: as últimas falas em markdown, com
 * ferramentas e pensamentos recolhidos, e um compositor que guarda o
 * rascunho mesmo ao recolher para o pet.
 */
export function conversationView(overlay: Overlay, sessionId: string): Screen {
  const head = h('div', { class: 'conversa-topo' });
  const log = h('div', {
    class: 'conversa-falas',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': l10n.t('Latest messages'),
    tabindex: '0',
  });
  const message = h('textarea', {
    rows: '2',
    'aria-label': l10n.t('Message to the agent'),
    placeholder: l10n.t('Write to the agent (Enter sends, Shift+Enter adds a line)'),
  });
  message.value = overlay.drafts.get(sessionId);
  const controls = h('div', { class: 'compositor-opcoes' });
  const sendButton = h(
    'button',
    { type: 'submit', class: 'primario enviar', 'aria-label': l10n.t('Send') },
    icon('enviar', 16),
  );

  const submit = (): void => {
    const text = message.value.trim();
    // A trava é do Overlay: Enter repetido e clique no botão são o mesmo envio.
    if (!text || overlay.isSending(sessionId)) return;
    sendButton.disabled = true;
    void overlay.compose(sessionId, text).then((ok) => {
      sendButton.disabled = !canSend(overlay.agent(sessionId));
      // Falhou: o rascunho fica. O que foi digitado durante o envio é de outra mensagem.
      if (!ok || message.value.trim() !== text) return;
      message.value = '';
      overlay.drafts.set(sessionId, '');
    });
  };

  message.addEventListener('input', () => {
    overlay.drafts.set(sessionId, message.value);
  });
  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  const composer = h(
    'form',
    {
      class: 'compositor',
      onsubmit: (event: Event) => {
        event.preventDefault();
        submit();
      },
    },
    h('div', { class: 'compositor-linha' }, message, sendButton),
    controls,
  );

  const element = h('div', { class: 'conversa' }, head, log, composer);
  let lastLog = '';

  const renderLog = (): void => {
    const failure = overlay.conversations.failure(sessionId);
    const items = overlay.conversations.items(sessionId);
    let children: Child[];
    if (failure) {
      children = [
        h(
          'p',
          { class: 'vazio' },
          l10n.t("Couldn't load the conversation: {0}", failure),
          ' ',
          h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: () => {
                overlay.retryConversation(sessionId);
              },
            },
            l10n.t('Try again'),
          ),
        ),
      ];
    } else if (!items) {
      children = [h('p', { class: 'vazio' }, l10n.t('Loading the conversation…'))];
    } else if (items.length === 0) {
      children = [h('p', { class: 'vazio' }, l10n.t('Nothing here yet. Write the first message.'))];
    } else {
      children = compactTranscript(items, 14).map(compactItem);
    }
    const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    patch(log, ...children);
    if (log.innerHTML !== lastLog && nearEnd) log.scrollTop = log.scrollHeight;
    lastLog = log.innerHTML;
  };

  const offPatch = overlay.onPatch((p) => {
    if (p.sessionId === sessionId) renderLog();
  });

  return {
    element,
    focus() {
      message.focus();
      log.scrollTop = log.scrollHeight;
    },
    dispose() {
      offPatch();
    },
    update() {
      const agent = overlay.agent(sessionId);
      const limited = overlay.snapshot().limited.has(sessionId);
      patch(head, ...headParts(overlay, sessionId, agent, limited));
      renderLog();
      const final = !agent || isFinalAgentState(agent.state);
      // Encerrada mas retomável: o Core reabre a sessão com a próxima mensagem.
      const writable = canSend(agent);
      message.disabled = !writable;
      sendButton.disabled = !writable || overlay.isSending(sessionId);
      message.placeholder = !writable
        ? l10n.t('This conversation has ended.')
        : final
          ? l10n.t('Write to resume this conversation (Enter sends, Shift+Enter adds a line)')
          : l10n.t('Write to the agent (Enter sends, Shift+Enter adds a line)');
      patch(controls, ...(agent && !final ? controlParts(overlay, agent) : []));
    },
  };
}

function headParts(
  overlay: Overlay,
  sessionId: string,
  agent: AgentSessionInfo | undefined,
  limited: boolean,
): Child[] {
  const share = agent ? contextShare(agent.usage) : undefined;
  const working = agent && stateTone(agent.state) === 'ativo';
  return [
    iconButton(
      'voltar',
      l10n.t('Back to the list'),
      () => {
        overlay.open({ name: 'inicio' });
      },
      { 'data-foco': 'c:voltar' },
    ),
    h(
      'div',
      {
        class: 'conversa-quem',
        'data-familia': agent ? family(agent) : 'outro',
        'data-tom': agent ? (limited ? 'ruim' : stateTone(agent.state)) : 'neutro',
      },
      h('span', { class: 'agente-ponto', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'agente-texto' },
        h(
          'span',
          { class: 'agente-nome' },
          h('strong', {}, agent?.nome ?? l10n.t('Agent')),
          agent && h('span', {}, agentTitle(agent)),
        ),
        h(
          'span',
          { class: 'agente-estado' },
          agent ? agentStateText(agent, limited) : l10n.t('Not in the Core list'),
          agent && h('span', { class: 'meta' }, usageText(agent)),
          share !== undefined &&
            miniRing(share, l10n.t('Context {0}%', Math.round(share * 100)), 14),
        ),
      ),
    ),
    working &&
      iconButton(
        'interromper',
        l10n.t('Interrupt'),
        () => void overlay.call('agents.pause', { sessionId }),
        { 'data-foco': 'c:pausa' },
      ),
    agent?.state === 'pausado' &&
      iconButton(
        'retomar',
        l10n.t('Resume'),
        () => void overlay.call('agents.resume', { sessionId }),
        { 'data-foco': 'c:retomar' },
      ),
    agent &&
      !isFinalAgentState(agent.state) &&
      iconButton(
        'parar',
        l10n.t('Stop this agent'),
        () => void overlay.call('agents.stop', { sessionId }),
        { 'data-foco': 'c:parar' },
      ),
    iconButton(
      'ide',
      l10n.t('Open this conversation in the IDE'),
      () => {
        overlay.reveal(sessionId);
      },
      { 'data-foco': 'c:ide' },
    ),
  ];
}

function compactItem(step: CompactItem): HTMLElement {
  if (step.kind === 'passos') {
    return h(
      'p',
      { class: 'passos', 'data-rodando': step.running },
      h('span', {}, stepsLabel(step)),
      step.last && h('span', { class: 'meta' }, step.last),
    );
  }
  const item = step.item;
  switch (item.kind) {
    case 'user':
      return h('div', { class: 'fala voce' }, item.text);
    case 'agent':
      return h('div', { class: 'fala agente-fala-md' }, markdown(item.text));
    case 'permission':
      return h(
        'p',
        { class: 'passos', 'data-resposta': item.answer ?? 'pendente' },
        icon('escudo', 12),
        inlineMarkdown(
          item.answer === 'permitido'
            ? l10n.t('Allowed: {0}', item.title)
            : item.answer === 'negado'
              ? l10n.t('Denied: {0}', item.title)
              : l10n.t('Asks for permission: {0}', item.title),
        ),
      );
    case 'notice':
      return h('p', { class: 'nota', 'data-tom': item.tone }, item.text);
    default:
      return h('p', { class: 'passos' }, '');
  }
}

/** Modo de permissão e modelo, trocados com o agente vivo. */
function controlParts(overlay: Overlay, agent: AgentSessionInfo): Child[] {
  const sessionId = agent.sessionId;
  const mode = h(
    'select',
    {
      'aria-label': l10n.t('Permission mode'),
      'data-foco': 'c:modo',
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value as PermissionPolicyName;
        void overlay
          .call('agents.setPermissions', { sessionId, permissions: value })
          .then((result) => {
            if (result !== undefined) overlay.notice(l10n.t('Mode: {0}.', modeLabel(value)));
          });
      },
    },
    ...PERMISSION_MODES.map((value) =>
      h('option', { value, selected: value === agent.permissoes }, modeLabel(value)),
    ),
  );
  const model = agent.opcoes.find(
    (option) => option.categoria === 'model' && (option.valores?.length ?? 0) > 0,
  );
  return [
    h('label', { class: 'campo-curto' }, icon('escudo', 12), mode),
    model &&
      h(
        'label',
        { class: 'campo-curto' },
        h(
          'select',
          {
            'aria-label': model.nome,
            'data-foco': 'c:modelo',
            onchange: (event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              void overlay.call('agents.setOption', { sessionId, id: model.id, value });
            },
          },
          ...(model.valores ?? []).map((value) =>
            h('option', { value: value.id, selected: value.id === model.atual }, value.nome),
          ),
        ),
      ),
  ];
}
