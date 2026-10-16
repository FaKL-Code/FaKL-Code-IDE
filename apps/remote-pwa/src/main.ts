import { l10n, useLocale } from '@fakl/i18n';
import { decodePairing, type PairingPayload } from '@fakl/remote';

import { app, isTab, type Route, type Tab } from './app.js';
import { h, icon, patch, ring, type IconName } from './dom.js';
import { closestCap } from './model.js';
import { loadMachine, type SavedMachine } from './storage.js';
import { agentsView } from './views/agentes.js';
import { settingsView } from './views/ajustes.js';
import { cafeView } from './views/cafe.js';
import { inboxView } from './views/caixa.js';
import { conversationView } from './views/conversa.js';
import { changesView } from './views/mudancas.js';
import { newConversationView } from './views/nova-conversa.js';
import { pairingScreen, welcomeScreen } from './views/parear.js';
import { iconButton, type View } from './views/parts.js';
import { newTaskView, taskView, tasksView } from './views/tarefas.js';
import { usageView } from './views/uso.js';
import { abrirPedidoPorVoz } from './views/voz-pedido.js';

/**
 * App do celular (SDD 12.4): a casca com topo, abas e a pilha de telas. Cada
 * tela é montada uma vez e se atualiza sozinha; a aba de baixo fica viva
 * enquanto uma tela de detalhe está por cima, com a rolagem guardada.
 */

// O idioma do celular escolhe o da interface, antes de qualquer texto na tela.
const locale = useLocale(navigator.language);
document.documentElement.lang = locale === 'pt-br' ? 'pt-BR' : 'en';
document.title = l10n.t('FaKL-Code remote');

const root = document.getElementById('app') ?? document.body;

function tabs(): readonly { id: Tab; label: string; icon: IconName }[] {
  return [
    { id: 'agentes', label: l10n.t('Agents'), icon: 'agentes' },
    { id: 'tarefas', label: l10n.t('Tasks'), icon: 'tarefas' },
    { id: 'caixa', label: l10n.t('Inbox'), icon: 'caixa' },
    { id: 'cafe', label: l10n.t('Café'), icon: 'cafe' },
    { id: 'uso', label: l10n.t('Usage'), icon: 'uso' },
  ];
}

function build(route: Route): View {
  switch (route.name) {
    case 'agentes':
      return agentsView();
    case 'tarefas':
      return tasksView();
    case 'caixa':
      return inboxView();
    case 'cafe':
      return cafeView();
    case 'uso':
      return usageView();
    case 'ajustes':
      return settingsView(() => {
        showWelcome();
      });
    case 'conversa':
      return conversationView(route.sessionId);
    case 'nova-conversa':
      return newConversationView();
    case 'mudancas':
      return changesView(route.sessionId, route.path);
    case 'tarefa':
      return taskView(route.taskId);
    case 'nova-tarefa':
      return newTaskView();
  }
}

// ---------------------------------------------------------------- casca

const top = h('header', { class: 'topo' });
const main = h('main', { class: 'conteudo' });
const nav = h('nav', { class: 'abas', 'aria-label': l10n.t('Sections') });
/** Entrada principal por voz: abre a folha "O que você quer?" sobre as abas. */
const fab = h(
  'button',
  {
    class: 'fab-voz',
    type: 'button',
    'aria-label': l10n.t('Speak a request'),
    title: l10n.t('Speak a request'),
    onclick: abrirPedidoPorVoz,
  },
  icon('microfone', 26),
);

let tabView: { tab: Tab; view: View; scroll: number } | undefined;
let detail: { route: Route; view: View } | undefined;

function current(): View | undefined {
  return detail?.view ?? tabView?.view;
}

function routed(): void {
  const route = app.route;
  const tab = app.tab;
  const covering = !isTab(route);
  const shown = tabView;
  if (covering && shown?.view.el === main.firstChild) shown.scroll = main.scrollTop;
  // O café não fica desenhando (nem pedindo miniaturas) debaixo de outra tela.
  const keepTab = !covering || tab !== 'cafe';
  if (tabView && (tabView.tab !== tab || !keepTab)) {
    tabView.view.dispose?.();
    tabView = undefined;
  }
  if (!tabView && keepTab) tabView = { tab, view: build({ name: tab }), scroll: 0 };
  if (detail && (!covering || detail.route !== route)) {
    detail.view.dispose?.();
    detail = undefined;
  }
  if (covering && !detail) detail = { route, view: build(route) };
  const view = current();
  if (!view) return;
  main.classList.toggle('cheia', view.fullscreen === true);
  if (main.firstChild !== view.el) {
    main.replaceChildren(view.el);
    main.scrollTop = detail ? 0 : (tabView?.scroll ?? 0);
  }
  paint();
}

/** Topo e abas; a tela atual se atualiza por conta própria. */
function paint(): void {
  const view = current();
  const isDetail = Boolean(detail);
  const dot = app.conexao === 'online' ? 'on' : app.conexao === 'conectando' ? 'meio' : 'off';
  const label =
    app.conexao === 'online'
      ? l10n.t('connected')
      : app.conexao === 'conectando'
        ? l10n.t('connecting…')
        : l10n.t('offline');
  const cap = closestCap(app.usage);
  patch(
    top,
    isDetail
      ? iconButton('voltar', l10n.t('Back'), () => {
          app.back();
        })
      : h('span', { class: 'selo', 'aria-hidden': 'true' }, '>_'),
    h(
      'div',
      { class: 'topo-titulo' },
      h('span', { class: 'titulo' }, view?.title?.() ?? app.machine?.nome ?? 'FaKL-Code'),
      h(
        'span',
        { class: `conexao ${dot}`, title: app.erro },
        h('span', { class: 'ponto' }),
        view?.subtitle?.() ?? label,
      ),
    ),
    ...(view?.actions?.() ?? []),
    !isDetail &&
      cap &&
      h(
        'button',
        {
          class: 'botao-icone teto',
          type: 'button',
          'aria-label': cap.teto
            ? l10n.t('Daily limit: {0} of {1}', cap.gasto, cap.teto)
            : l10n.t('Daily limit: {0}', cap.gasto),
          onclick: () => {
            app.go({ name: 'uso' });
          },
        },
        ring(cap.bloqueado ? 1 : cap.fracao, { size: 30 }),
      ),
    !isDetail &&
      iconButton('ajustes', l10n.t('Settings'), () => {
        app.go({ name: 'ajustes' });
      }),
  );
  const fullscreen = view?.fullscreen === true;
  nav.hidden = fullscreen;
  fab.hidden = isDetail || fullscreen || !app.can('comandar');
  patch(
    nav,
    ...tabs().map((tab) => {
      const active = app.tab === tab.id && !isDetail;
      const count =
        tab.id === 'caixa'
          ? app.pending
          : tab.id === 'agentes'
            ? app.agents.filter((a) => a.state === 'aguardando-você').length
            : 0;
      return h(
        'button',
        {
          class: active ? 'ativa' : '',
          type: 'button',
          'aria-current': active ? 'page' : false,
          onclick: () => {
            if (app.tab === tab.id && !detail) main.scrollTo({ top: 0, behavior: 'smooth' });
            else app.go({ name: tab.id });
          },
        },
        icon(tab.icon, 22),
        h('span', {}, tab.label),
        count > 0 &&
          h(
            'span',
            { class: 'contagem', 'aria-label': l10n.t('{0} pending', count) },
            String(count),
          ),
      );
    }),
  );
}

function update(): void {
  current()?.update();
  // Debaixo de uma tela de detalhe, a aba também segue atualizada.
  if (detail) tabView?.view.update();
  paint();
}

function showApp(): void {
  root.replaceChildren(top, main, nav, fab);
  app.stack = [{ name: 'agentes' }];
  history.replaceState({ depth: 0 }, '');
  routed();
}

function showWelcome(message?: string): void {
  tabView?.view.dispose?.();
  detail?.view.dispose?.();
  tabView = undefined;
  detail = undefined;
  root.replaceChildren(welcomeScreen((payload) => void showPairing(payload), message));
}

async function showPairing(payload: PairingPayload): Promise<void> {
  root.replaceChildren(
    await pairingScreen(payload, (machine: SavedMachine) => {
      app.machine = machine;
      showApp();
      void app.connect();
    }),
  );
}

app.onChange(update);
app.onRoute(routed);
app.onForgotten = showWelcome;
window.addEventListener('popstate', () => {
  app.popped();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') app.wake();
});
window.addEventListener('online', () => {
  app.wake();
});
// O relógio relativo ("há 3 min") anda sozinho.
window.setInterval(() => {
  if (document.visibilityState === 'visible' && app.machine) update();
}, 30_000);

// ---------------------------------------------------------------- início

async function start(): Promise<void> {
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => undefined);
  }
  const pairing = new URLSearchParams(location.hash.slice(1)).get('p');
  if (pairing) {
    try {
      await showPairing(decodePairing(pairing));
    } catch {
      showWelcome(l10n.t('This QR code is not valid. Generate another one in the IDE.'));
    }
    return;
  }
  app.machine = await loadMachine().catch(() => undefined);
  if (!app.machine) {
    showWelcome();
    return;
  }
  showApp();
  await app.connect();
}

void start();
