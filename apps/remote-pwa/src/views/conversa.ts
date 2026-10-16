import { contextShare, formatCost, formatTokens, preview, usageBreakdown } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  PERMISSION_MODES,
  type AgentOptionInfo,
  type AgentSessionInfo,
  type ChatItem,
  type PermissionPolicyName,
} from '@fakl/protocol';

import { app } from '../app.js';
import { copy, h, icon, markdown, ring, sheet, toast, toolIcon, type SheetItem } from '../dom.js';
import { isWorking } from '../model.js';
import { openClaudeAccounts, usesClaudeAccount } from './contas.js';
import { iconButton, stateChip, where, type View } from './parts.js';
import { abrirPedidoPorVoz } from './voz-pedido.js';
import { criarDitado } from './voz.js';

function modes(): Record<PermissionPolicyName, { label: string; description: string }> {
  return {
    perguntar: { label: l10n.t('Ask'), description: l10n.t('Asks permission for each action') },
    'aprovar-leitura': {
      label: l10n.t('Approve reads'),
      description: l10n.t('Reads on its own; asks before changing'),
    },
    'aprovar-tudo': {
      label: l10n.t('Approve all'),
      description: l10n.t('Does everything without asking'),
    },
    autopilot: {
      label: l10n.t('Autopilot'),
      description: l10n.t('Does everything and applies the changes to your folder'),
    },
  };
}

/** Rascunhos por conversa, para não perder o texto ao sair e voltar. */
const drafts = new Map<string, string>();

/** Distância do fim abaixo da qual a lista acompanha as mensagens novas. */
const STICK_PX = 80;

export function conversationView(sessionId: string): View {
  const agent = (): AgentSessionInfo | undefined => app.agent(sessionId);

  // ------------------------------------------------------------ faixa de uso
  const strip = h('button', { class: 'faixa', type: 'button', 'aria-expanded': 'false' });
  const details = h('div', { class: 'faixa-detalhes', hidden: true });
  strip.addEventListener('click', () => {
    details.hidden = !details.hidden;
    strip.setAttribute('aria-expanded', String(!details.hidden));
    renderStrip();
  });

  // ------------------------------------------------------------ mensagens
  const list = h('div', { class: 'mensagens', role: 'log', 'aria-live': 'polite' });
  const top = h('p', { class: 'omitidos', hidden: true });
  const typing = h(
    'div',
    { class: 'digitando', hidden: true, 'aria-label': l10n.t('The agent is working') },
    h('span'),
    h('span'),
    h('span'),
  );
  const items = h('div', { class: 'itens' });
  list.append(top, items, typing);
  const jump = h(
    'button',
    {
      class: 'pular',
      type: 'button',
      hidden: true,
      'aria-label': l10n.t('Jump to the end'),
      onclick: () => {
        list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
      },
    },
    icon('baixo', 18),
  );
  list.addEventListener('scroll', () => {
    jump.hidden = nearBottom();
  });

  // ------------------------------------------------------------ compositor
  const input = h('textarea', {
    rows: '1',
    placeholder: l10n.t('Message to the agent'),
    'aria-label': l10n.t('Message to the agent'),
  });
  input.value = drafts.get(sessionId) ?? '';
  const ditado = criarDitado(input);
  const sendButton = h(
    'button',
    { class: 'enviar', type: 'submit', 'aria-label': l10n.t('Send') },
    icon('enviar', 20),
  );
  const composer = h(
    'form',
    {
      class: 'compositor',
      onsubmit: (event: Event) => {
        event.preventDefault();
        send();
      },
    },
    input,
    ditado.botao,
    sendButton,
  );
  const closed = h('p', { class: 'compositor-fechado', hidden: true });
  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${String(Math.min(input.scrollHeight, 160))}px`;
  };
  input.addEventListener('input', () => {
    drafts.set(sessionId, input.value);
    autosize();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  });

  const el = h(
    'div',
    { class: 'tela conversa' },
    h('div', { class: 'faixa-caixa' }, strip, details),
    list,
    jump,
    composer,
    closed,
  );

  // ------------------------------------------------------------ desenho
  let nodes: HTMLElement[] = [];
  let pendingKey = '';
  const dirty = new Set<number>();
  let frame = 0;
  let reset = true;

  const nearBottom = (): boolean =>
    list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;

  const flush = (): void => {
    frame = 0;
    const conversation = app.conversations.items(sessionId);
    const stick = reset || nearBottom();
    const failure = app.conversations.failure(sessionId);
    if (!conversation) {
      nodes = [];
      items.replaceChildren(
        failure
          ? h(
              'div',
              { class: 'carregando' },
              h('p', {}, l10n.t("Couldn't load the conversation: {0}", failure)),
              h(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    app.retryConversation(sessionId);
                  },
                },
                l10n.t('Try again'),
              ),
            )
          : h(
              'p',
              { class: 'carregando' },
              app.session
                ? l10n.t('Loading the conversation…')
                : l10n.t('No connection to the IDE.'),
            ),
      );
    } else if (reset) {
      nodes = conversation.map((item) => renderItem(item));
      items.replaceChildren(...nodes);
      if (nodes.length === 0) {
        items.append(h('p', { class: 'carregando' }, l10n.t('No messages yet.')));
      }
    } else {
      if (nodes.length === 0) items.replaceChildren();
      for (const index of [...dirty].sort((a, b) => a - b)) {
        const item = conversation[index];
        if (!item) continue;
        const node = renderItem(item);
        const old = nodes[index];
        if (old) old.replaceWith(node);
        else items.append(node);
        nodes[index] = node;
      }
    }
    const omitted = app.conversations.omitidos(sessionId);
    top.hidden = omitted === 0;
    top.textContent =
      omitted === 1
        ? l10n.t('1 earlier item was left out; the full conversation is in the IDE.')
        : l10n.t('{0} earlier items were left out; the full conversation is in the IDE.', omitted);
    reset = false;
    dirty.clear();
    if (stick) list.scrollTop = list.scrollHeight;
    jump.hidden = nearBottom();
  };

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const unsubscribe = app.onPatch((patch) => {
    if (patch.sessionId !== sessionId) return;
    if (patch.reset) reset = true;
    for (const index of patch.indexes) dirty.add(index);
    schedule();
  });

  const renderItem = (item: ChatItem): HTMLElement => {
    switch (item.kind) {
      case 'user':
        return h('div', { class: 'msg usuario' }, h('div', { class: 'balao' }, item.text));
      case 'agent':
        return h('div', { class: 'msg agente' }, markdown(item.text));
      case 'thought': {
        const box = h(
          'details',
          { class: 'msg pensamento' },
          h(
            'summary',
            {},
            icon('ideia', 15),
            h('span', {}, preview(item.text) || l10n.t('Thinking')),
          ),
        );
        // O markdown só é montado quando abrem, para não pesar em pensamentos longos.
        box.addEventListener('toggle', () => {
          if (box.open && box.childElementCount === 1) box.append(markdown(item.text));
        });
        return box;
      }
      case 'tool': {
        const status = item.status ?? 'pending';
        const running = status === 'pending' || status === 'in_progress';
        return h(
          'div',
          { class: `msg ferramenta ${running ? 'rodando' : status}` },
          h('span', { class: 'ferramenta-icone' }, icon(toolIcon(item.toolKind), 15)),
          h('span', { class: 'ferramenta-titulo' }, item.title),
          running
            ? h('span', { class: 'giro', 'aria-label': l10n.t('in progress') })
            : status === 'failed'
              ? h(
                  'span',
                  { class: 'ferramenta-fim ruim', 'aria-label': l10n.t('failed') },
                  icon('x', 14),
                )
              : h(
                  'span',
                  { class: 'ferramenta-fim', 'aria-label': l10n.t('tool done') },
                  icon('check', 14),
                ),
        );
      }
      case 'permission': {
        const open = app.permissions.find((p) => p.sessionId === sessionId && p.id === item.id);
        return h(
          'div',
          { class: `msg permissao${item.answer ? ` ${item.answer}` : ''}` },
          h('p', { class: 'pedido-titulo' }, icon('escudo', 16), h('span', {}, item.title)),
          item.answer
            ? h(
                'p',
                { class: 'meta' },
                item.answer === 'permitido' ? l10n.t('Allowed') : l10n.t('Denied'),
              )
            : open && app.can('decidir')
              ? h(
                  'div',
                  { class: 'acoes' },
                  h(
                    'button',
                    {
                      class: 'primario',
                      type: 'button',
                      onclick: () => {
                        answer(item.id, true);
                      },
                    },
                    l10n.t('Allow'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onclick: () => {
                        answer(item.id, false);
                      },
                    },
                    l10n.t('Deny'),
                  ),
                )
              : h(
                  'p',
                  { class: 'meta' },
                  open ? l10n.t('Waiting for an answer in the IDE') : l10n.t('No answer'),
                ),
        );
      }
      case 'notice':
        return h('p', { class: `msg aviso ${item.tone}` }, item.text);
    }
  };

  const answer = (id: string, allow: boolean): void => {
    void app.call('agents.permission', { sessionId, id, allow }).then((result) => {
      if (result === undefined) return;
      app.permissions = app.permissions.filter((p) => !(p.sessionId === sessionId && p.id === id));
      app.changed();
    });
  };

  // ------------------------------------------------------------ faixa e estado
  const renderStrip = (): void => {
    const current = agent();
    if (!current) {
      strip.replaceChildren(h('span', { class: 'meta' }, l10n.t('Session not found in the IDE.')));
      details.replaceChildren();
      return;
    }
    const usage = usageBreakdown(current.usage);
    const share = contextShare(current.usage);
    const cost = formatCost(current.usage.cost);
    strip.replaceChildren(
      stateChip(current),
      h(
        'span',
        { class: 'faixa-onde' },
        icon(current.worktree ? 'ramo' : 'pasta', 14),
        where(current),
      ),
      h(
        'span',
        { class: 'faixa-uso' },
        usage.total > 0 ? `${formatTokens(usage.total)} tok` : '',
        cost && ` · ${cost}`,
      ),
      share !== undefined ? ring(share, { size: 28 }) : icon('uso', 18),
    );
    if (details.hidden) return;
    const context = current.usage.context;
    const option = (o: AgentOptionInfo): string =>
      typeof o.atual === 'boolean'
        ? o.atual
          ? l10n.t('on')
          : l10n.t('off')
        : (o.valores?.find((v) => v.id === o.atual)?.nome ?? o.atual);
    details.replaceChildren(
      h(
        'div',
        { class: 'aneis' },
        stat(
          share,
          l10n.t('Context'),
          context
            ? l10n.t('{0} of {1}', formatTokens(context.used), formatTokens(context.size))
            : l10n.t('not reported'),
        ),
        stat(
          usage.total > 0 ? usage.inputShare : undefined,
          l10n.t('Input'),
          `${formatTokens(usage.input)} tok`,
          'azul',
        ),
        stat(
          usage.total > 0 ? usage.outputShare : undefined,
          l10n.t('Output'),
          `${formatTokens(usage.output)} tok`,
          'verde',
        ),
      ),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, l10n.t('Cost')),
        h('dd', {}, cost || l10n.t('not reported by the agent')),
        h('dt', {}, l10n.t('Mode')),
        h('dd', {}, modes()[current.permissoes].label),
        ...current.opcoes.flatMap((o) => [h('dt', {}, o.nome), h('dd', {}, option(o))]),
        h('dt', {}, l10n.t('Folder')),
        h('dd', { class: 'mono' }, current.worktree?.path ?? current.cwd),
      ),
    );
  };

  const update = (): void => {
    renderStrip();
    const current = agent();
    const ended = !current || isFinalAgentState(current.state);
    const allowed = app.can('comandar');
    composer.hidden = ended || !allowed;
    closed.hidden = !composer.hidden;
    closed.textContent = !current
      ? l10n.t('The IDE no longer knows this session.')
      : ended
        ? l10n.t('This agent has ended. Start a new conversation to continue.')
        : l10n.t('This device can only view; sending messages needs the "comandar" permission.');
    typing.hidden = !current || !isWorking(current.state);
    if (!app.conversations.has(sessionId) && app.session) {
      void app.openConversation(sessionId);
    }
    // Pedidos de permissão podem ter sido respondidos fora daqui; só então
    // os botões são refeitos, para um toque não cair num botão trocado.
    const open = app.permissions
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.id)
      .join(' ');
    if (open !== pendingKey) {
      pendingKey = open;
      app.conversations.items(sessionId)?.forEach((item, index) => {
        if (item.kind === 'permission' && !item.answer) dirty.add(index);
      });
      if (dirty.size > 0) schedule();
    }
  };

  const send = (): void => {
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;
    sendButton.disabled = true;
    void app.call('agents.send', { sessionId, message: text }).then((result) => {
      sendButton.disabled = false;
      if (result === undefined) return;
      // Só limpa o que foi enviado; o que foi digitado durante o envio fica.
      if (input.value.trim() === text) input.value = '';
      if (input.value) drafts.set(sessionId, input.value);
      else drafts.delete(sessionId);
      autosize();
      list.scrollTop = list.scrollHeight;
    });
  };

  update();
  schedule();
  requestAnimationFrame(autosize);

  return {
    el,
    fullscreen: true,
    title: () => agent()?.nome ?? l10n.t('Conversation'),
    actions: () => [
      app.can('comandar') && iconButton('microfone', l10n.t('Speak a request'), abrirPedidoPorVoz),
      iconButton('menu', l10n.t('Agent actions'), () => {
        openMenu(sessionId);
      }),
    ],
    update,
    dispose: () => {
      ditado.cancelar();
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

function stat(
  fraction: number | undefined,
  title: string,
  value: string,
  tone?: string,
): HTMLElement {
  return h(
    'div',
    { class: 'anel-info' },
    ring(fraction, tone ? { size: 52, tone } : { size: 52 }),
    h('span', { class: 'anel-titulo' }, title),
    h('span', { class: 'meta' }, value),
  );
}

function openMenu(sessionId: string): void {
  const agent = app.agent(sessionId);
  const items: SheetItem[] = [];
  const command = app.can('comandar');
  if (agent && command && !isFinalAgentState(agent.state)) {
    const paused = agent.state === 'pausado';
    items.push({
      label: paused ? l10n.t('Resume') : l10n.t('Pause'),
      icon: paused ? 'retomar' : 'pausar',
      run: () => void app.call(paused ? 'agents.resume' : 'agents.pause', { sessionId }),
    });
  }
  if (agent?.worktree) {
    items.push({
      label: l10n.t('View changes'),
      description: agent.worktree.branch,
      icon: 'diff',
      run: () => {
        app.go({ name: 'mudancas', sessionId });
      },
    });
  }
  items.push({
    label: l10n.t('Copy the conversation'),
    icon: 'copiar',
    run: () => void copy(transcriptText(sessionId, agent?.nome ?? l10n.t('Agent'))),
  });
  if (agent && command && !isFinalAgentState(agent.state)) {
    items.push({ kind: 'secao', label: l10n.t('Permission mode') });
    const labels = modes();
    for (const mode of PERMISSION_MODES) {
      items.push({
        label: labels[mode].label,
        description: labels[mode].description,
        icon: 'escudo',
        checked: agent.permissoes === mode,
        run: () => {
          if (mode !== agent.permissoes) {
            void app.call('agents.setPermissions', { sessionId, permissions: mode }).then((r) => {
              if (r !== undefined) toast(l10n.t('Mode: {0}.', labels[mode].label));
            });
          }
        },
      });
    }
    for (const option of agent.opcoes) {
      if (!option.valores || option.valores.length === 0) continue;
      const current = option.valores.find((v) => v.id === option.atual);
      items.push({
        label: option.nome,
        description: current?.nome ?? String(option.atual),
        icon: 'modelo',
        run: () => {
          openOption(sessionId, option);
        },
      });
    }
    if (usesClaudeAccount(agent)) {
      items.push({
        label: l10n.t('Claude account'),
        description: agent.contaClaude?.apelido ?? l10n.t('Default Claude Code account'),
        icon: 'chave',
        run: () => void openClaudeAccounts(),
      });
    }
    items.push({
      label: l10n.t('Stop the agent'),
      icon: 'parar',
      danger: true,
      run: () => {
        if (confirm(l10n.t('Stop {0}? Its work stays saved on its branch.', agent.nome))) {
          void app.call('agents.stop', { sessionId });
        }
      },
    });
  }
  sheet(agent?.nome ?? l10n.t('Conversation'), items);
}

function openOption(sessionId: string, option: AgentOptionInfo): void {
  sheet(
    option.nome,
    (option.valores ?? []).map((value) => ({
      label: value.nome,
      ...(value.descricao ? { description: value.descricao } : {}),
      checked: value.id === option.atual,
      run: () => {
        if (value.id !== option.atual) {
          void app.call('agents.setOption', { sessionId, id: option.id, value: value.id });
        }
      },
    })),
  );
}

function transcriptText(sessionId: string, nome: string): string {
  return (app.conversations.items(sessionId) ?? [])
    .map((item) => {
      switch (item.kind) {
        case 'user':
          return `${l10n.t('You:')}\n${item.text}`;
        case 'agent':
          return `${nome}:\n${item.text}`;
        case 'tool':
          return l10n.t('[tool] {0}', item.title);
        case 'permission':
          return l10n.t('[permission] {0}', item.title);
        case 'notice':
          return `[${item.tone}] ${item.text}`;
        case 'thought':
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
