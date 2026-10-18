import { l10n, useLocale } from '@fakl/i18n';
import type {
  AgentChangedFile,
  AgentProfileAvailability,
  AgentSessionInfo,
  CostSummary,
  ExternalListResult,
  ExternalSource,
  PermissionPolicyName,
  VozStatus,
} from '@fakl/protocol';

import type { FromMesa, MesaCommand, ToMesa } from '../mesa-protocol.js';
import type { ChatItem } from '@fakl/conversa';
import { escapeHtml, renderMarkdown } from '@fakl/conversa';
import { agentStateLabel, logoKey } from './chat-model.js';
import { initCoach } from './coach.js';
import { providerLogo } from './icons.js';
import {
  criarMicrofone,
  criarTranscritor,
  desenho,
  ehAtalhoDeVoz,
  type Microfone,
} from './voz-mic.js';
import {
  accentFor,
  attentionQueue,
  bounds,
  CARD_H,
  CARD_W,
  clampZoom,
  EMPTY_LAYOUT,
  expandMentions,
  fitView,
  floorsOf,
  GRID,
  initials,
  mentionAt,
  NOTE_H,
  NOTE_W,
  placeNew,
  PORTAL_H,
  PORTAL_W,
  portalUrl,
  roleColor,
  ropePath,
  snap,
  tidy,
  toneOf,
  usageRing,
  type Floor,
  type MesaLayout,
  type MesaLink,
  type MesaNote,
  type MesaPortal,
  type MesaRole,
  type Rect,
} from './mesa-model.js';

interface VsCodeApi {
  postMessage(message: FromMesa): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>; vem antes de montar a Mesa.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();
const post = (message: FromMesa): void => {
  vscode.postMessage(message);
};

// Voz: o microfone de cada cartão dita no campo; o host transcreve pelo Core.
const transcritor = criarTranscritor(post);
const microfones = new WeakMap<HTMLButtonElement, Microfone>();

/** Para a gravação do cartão (removido ou com o compositor oculto): nada de transcrição tardia. */
function cancelarMicrofone(node: HTMLElement): void {
  const botao = node.querySelector<HTMLButtonElement>('.voz-mic');
  if (botao) microfones.get(botao)?.cancelar();
}
let vozStatus: VozStatus | undefined;

function modes(): readonly { value: PermissionPolicyName; label: string }[] {
  return [
    { value: 'perguntar', label: l10n.t('Ask') },
    { value: 'aprovar-leitura', label: l10n.t('Approve reads') },
    { value: 'aprovar-tudo', label: l10n.t('Approve all') },
    { value: 'autopilot', label: l10n.t('Autopilot') },
  ];
}

function floorLabel(state: Floor['state']): string {
  switch (state) {
    case 'trabalhando':
      return l10n.t('Working');
    case 'bloqueado':
      return l10n.t('Waiting for you');
    case 'revisar':
      return l10n.t('Ready for review');
    case 'livre':
      return l10n.t('Idle');
    case 'concluído':
      return l10n.t('Finished');
  }
}

type Tool = 'selecionar' | 'mover' | 'agente' | 'nota' | 'previa' | 'ligar';

interface ToolInfo {
  readonly id: Tool | 'tarefa' | 'enquadrar' | 'arrumar' | 'atencao';
  readonly label: string;
  readonly key: string;
  readonly icon: string;
  readonly title: string;
}

function tools(): readonly ToolInfo[] {
  return [
    {
      id: 'selecionar',
      label: l10n.t('Select'),
      key: 'V',
      icon: 'M5 3l14 8-6 2-3 6z',
      title: l10n.t('Select and drag cards'),
    },
    {
      id: 'mover',
      label: l10n.t('Pan'),
      key: 'H',
      icon: 'M12 3v18M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5',
      title: l10n.t('Drag the desk (or hold Space)'),
    },
    {
      id: 'agente',
      label: l10n.t('Agent'),
      key: 'N',
      icon: 'M12 4v16M4 12h16',
      title: l10n.t('Click the desk to place a new agent'),
    },
    {
      id: 'tarefa',
      label: l10n.t('Task'),
      key: 'T',
      icon: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
      title: l10n.t('New task for the maestro'),
    },
    {
      id: 'nota',
      label: l10n.t('Note'),
      key: 'O',
      icon: 'M5 4h11l3 3v13H5zM9 10h6M9 14h6',
      title: l10n.t('Click the desk to place a note'),
    },
    {
      id: 'previa',
      label: l10n.t('Preview'),
      key: 'P',
      icon: 'M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01',
      title: l10n.t('Click the desk to open the app preview (localhost)'),
    },
    {
      id: 'ligar',
      label: l10n.t('Cable'),
      key: 'L',
      icon: 'M4 18c4 0 4-12 8-12s4 12 8 12',
      title: l10n.t('Connect two cards; click a cable to remove it'),
    },
    {
      id: 'atencao',
      label: l10n.t('Attention'),
      key: 'A',
      icon: 'M12 4l9 16H3zM12 10v4M12 17v.5',
      title: l10n.t('Go to the next agent waiting for you'),
    },
    {
      id: 'arrumar',
      label: l10n.t('Arrange'),
      key: 'R',
      icon: 'M4 5h6v6H4zM14 5h6v6h-6zM9 15h6v6H9zM7 11v2h10v-2M12 13v2',
      title: l10n.t('Arrange as a tree: maestro on top, subagents below'),
    },
    {
      id: 'enquadrar',
      label: l10n.t('Fit'),
      key: 'F',
      icon: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
      title: l10n.t('Show all cards'),
    },
  ];
}

// ---- Estado ---------------------------------------------------------------

let layout: MesaLayout = EMPTY_LAYOUT;
let cards: Record<string, Rect> = {};
let notes: MesaNote[] = [];
let portals: MesaPortal[] = [];
let links: MesaLink[] = [];
let view = { ...EMPTY_LAYOUT.view };
let sessions: readonly AgentSessionInfo[] = [];
let roles: readonly MesaRole[] = [];
let profiles: readonly AgentProfileAvailability[] = [];
let hasFolder = true;
let loaded = false;
let tool: Tool = 'selecionar';
let linkFrom: string | undefined;
let selectedNote: string | undefined;
let lifted: string | undefined;
let landing: string | undefined;
let attentionIndex = 0;
const transcripts = new Map<string, ChatItem[]>();
const changes = new Map<string, readonly AgentChangedFile[]>();
const drafts = new Map<string, string>();
let usage: CostSummary | undefined;
let external: ExternalListResult = { ativo: false, sessoes: [] };
const EXTERNAL_NAMES: Record<ExternalSource, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
};

/** Notas e prévias: o que fica na mesa além dos agentes. */
function freeRects(): Rect[] {
  return [...notes, ...portals];
}

// ---- DOM ------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

/**
 * Avatar do agente: a marca oficial do provedor (Claude, Codex, Gemini...) quando
 * há, senão as iniciais. A marca usa a cor de destaque do avatar (currentColor).
 */
function paintAvatar(
  node: HTMLElement,
  name: string,
  provedor: string | undefined,
  size: number,
): void {
  const logo = logoKey(provedor, true);
  node.classList.toggle('has-logo', logo !== undefined);
  if (logo) node.replaceChildren(providerLogo(logo, size));
  else node.textContent = initials(name);
}

const root = document.getElementById('mesa') ?? document.body;

// Barra lateral: andares e agentes.
const sidebar = el('aside', { class: 'sidebar', 'aria-label': l10n.t('Floors and agents') });
const brand = el('div', { class: 'brand' });
brand.append(
  el('span', { class: 'logo', 'aria-hidden': 'true' }, '>_'),
  el('span', {}, l10n.t('Desk')),
);
const summary = el('div', { class: 'summary' });
const usageTitle = el('h2', { hidden: '' }, l10n.t('Usage today'));
const usageList = el('ul', { class: 'rings', hidden: '' });
const floorsTitle = el('h2', {}, l10n.t('Floors'));
const floorsList = el('ul', { class: 'floors' });
const agentsTitle = el('h2', {}, l10n.t('Agents'));
const agentsList = el('ul', { class: 'agents' });
// Conversas das extensões do Codex e do Claude Code: só leitura (ADR 0039).
const externalTitle = el('h2', {}, l10n.t('Other tools'));
const externalNote = el('p', { class: 'external-note' });
const externalEnable = el(
  'button',
  {
    type: 'button',
    class: 'link',
    title: l10n.t('FaKL reads the local history of the Codex and Claude Code extensions'),
  },
  l10n.t('Show their conversations…'),
);
externalEnable.addEventListener('click', () => {
  post({ type: 'externasAtivar' });
});
const externalList = el('ul', { class: 'agents external' });
const sideFooter = el('div', { class: 'side-footer' });
const clearButton = el('button', { type: 'button', class: 'ghost' }, l10n.t('Clear finished'));
clearButton.addEventListener('click', () => {
  post({ type: 'clearFinished' });
});
const shortcuts = el('div', { class: 'side-links' });
for (const [command, label] of [
  ['tarefa', l10n.t('Tasks')],
  ['vault', 'Vault'],
  ['custos', l10n.t('Costs')],
  ['cafe', 'Café'],
  ['remoto', l10n.t('Phone')],
] as const) {
  const link = el('button', { type: 'button', class: 'link' }, label);
  link.addEventListener('click', () => {
    post({ type: 'command', command: command as MesaCommand });
  });
  shortcuts.append(link);
}
sideFooter.append(clearButton, shortcuts);
sidebar.append(
  brand,
  summary,
  usageTitle,
  usageList,
  floorsTitle,
  floorsList,
  agentsTitle,
  agentsList,
  externalTitle,
  externalNote,
  externalEnable,
  externalList,
  sideFooter,
);

// Palco: o canvas infinito.
const stage = el('main', { class: 'stage' });
const viewport = el('div', {
  class: 'viewport',
  tabindex: '0',
  'aria-label': l10n.t('Agent desk'),
});
const world = el('div', { class: 'world' });
const ropes = document.createElementNS(SVG_NS, 'svg');
ropes.setAttribute('class', 'ropes');
ropes.setAttribute('aria-hidden', 'true');
const zones = el('div', { class: 'zones' });
const cardLayer = el('div', { class: 'cards' });
world.append(zones, ropes, cardLayer);
viewport.append(world);

const topbar = el('div', { class: 'topbar' });
const attentionButton = el('button', { type: 'button', class: 'attention', hidden: '' });
const zoomOut = el(
  'button',
  {
    type: 'button',
    class: 'icon',
    title: l10n.t('Zoom out (-)'),
    'aria-label': l10n.t('Zoom out'),
  },
  '−',
);
const zoomLabel = el(
  'button',
  { type: 'button', class: 'zoom', title: l10n.t('Reset to 100%') },
  '100%',
);
const zoomIn = el(
  'button',
  { type: 'button', class: 'icon', title: l10n.t('Zoom in (+)'), 'aria-label': l10n.t('Zoom in') },
  '+',
);
const zoomBox = el('div', { class: 'zoom-box' });
zoomBox.append(zoomOut, zoomLabel, zoomIn);
const focusButton = el(
  'button',
  { type: 'button', class: 'focus', title: l10n.t('Hides the IDE bars and leaves only the Desk') },
  l10n.t('Focus'),
);
focusButton.prepend(icon('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', 14));
focusButton.addEventListener('click', () => {
  post({ type: 'command', command: 'foco' });
});
const speakButton = el('button', {
  type: 'button',
  class: 'focus speak',
  title: l10n.t('Speak a request: it becomes a task, a new chat or a message (Ctrl+Alt+V)'),
});
speakButton.append(desenho('mic', 14), el('span', {}, l10n.t('Speak')));
speakButton.addEventListener('click', () => {
  post({ type: 'command', command: 'voz' });
});
topbar.append(attentionButton, speakButton, focusButton, zoomBox);

const toolbar = el('nav', { class: 'toolbar', 'aria-label': l10n.t('Desk tools') });
const toolButtons = new Map<string, HTMLButtonElement>();
for (const info of tools()) {
  const button = el('button', { type: 'button', title: `${info.title} (${info.key})` });
  button.append(icon(info.icon, 18), el('span', {}, info.label), el('kbd', {}, info.key));
  button.addEventListener('click', () => {
    runTool(info.id);
  });
  toolButtons.set(info.id, button);
  toolbar.append(button);
}

const minimap = el('canvas', {
  class: 'minimap',
  width: '200',
  height: '130',
  'aria-label': l10n.t('Minimap'),
});
const empty = el('div', { class: 'empty', hidden: '' });
const hint = el('div', { class: 'hint', hidden: '' });
const menu = el('div', { class: 'menu', role: 'menu', hidden: '' });
const sheet = el('aside', { class: 'sheet', hidden: '', 'aria-label': l10n.t('Land floor') });
const liftLayer = el('div', { class: 'lift', hidden: '' });
const toast = el('div', { class: 'toast', role: 'alert', hidden: '' });
stage.append(viewport, topbar, toolbar, minimap, empty, hint, menu, sheet, liftLayer, toast);
root.append(sidebar, stage);

// ---- Visão (pan e zoom) ---------------------------------------------------

function applyView(): void {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  const size = GRID * view.zoom;
  viewport.style.backgroundSize = `${size}px ${size}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  root.classList.toggle('far', view.zoom < 0.55);
  drawMinimap();
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const box = viewport.getBoundingClientRect();
  return {
    x: (clientX - box.left - view.x) / view.zoom,
    y: (clientY - box.top - view.y) / view.zoom,
  };
}

function zoomAt(factor: number, clientX?: number, clientY?: number): void {
  const box = viewport.getBoundingClientRect();
  const cx = (clientX ?? box.left + box.width / 2) - box.left;
  const cy = (clientY ?? box.top + box.height / 2) - box.top;
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  view = { zoom, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
  applyView();
  save();
}

function animateTo(target: { x: number; y: number; zoom: number }): void {
  world.classList.add('gliding');
  view = { ...target };
  applyView();
  setTimeout(() => {
    world.classList.remove('gliding');
  }, 320);
  save();
}

function centerOn(rect: Rect, zoom = Math.max(view.zoom, 0.9)): void {
  const box = viewport.getBoundingClientRect();
  animateTo({
    zoom,
    x: box.width / 2 - (rect.x + rect.w / 2) * zoom,
    y: box.height / 2 - (rect.y + rect.h / 2) * zoom,
  });
}

function fitAll(): void {
  const area = bounds([
    ...visibleCards()
      .map((s) => cards[s.sessionId])
      .filter(isRect),
    ...freeRects(),
  ]);
  if (!area) return;
  const box = viewport.getBoundingClientRect();
  animateTo(fitView(area, box.width, box.height));
}

function isRect(rect: Rect | undefined): rect is Rect {
  return rect !== undefined;
}

// ---- Persistência ---------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const known = new Set(sessions.map((s) => s.sessionId));
    const kept: Record<string, Rect> = {};
    for (const [id, rect] of Object.entries(cards)) {
      if (!loaded || known.has(id)) kept[id] = rect;
    }
    layout = { cards: kept, notes, portals, links, view };
    post({ type: 'saveLayout', layout });
  }, 400);
}

// ---- Render ---------------------------------------------------------------

function profileOf(session: AgentSessionInfo): AgentProfileAvailability | undefined {
  return profiles.find((p) => p.id === session.profileId);
}

function accentOf(session: AgentSessionInfo): string {
  return accentFor(profileOf(session)?.provedor ?? session.profileId);
}

function roleOf(sessionId: string): MesaRole | undefined {
  return roles.find((r) => r.sessionId === sessionId);
}

function visibleCards(): readonly AgentSessionInfo[] {
  return sessions;
}

function ensurePlaced(): void {
  let changed = false;
  let placed: Rect | undefined;
  // Mesa nova: arruma tudo em árvore de uma vez.
  if (Object.keys(cards).length === 0 && sessions.length > 0) {
    const ids = [...sessions].sort((x, y) => x.sessionId.localeCompare(y.sessionId));
    cards = tidy(
      ids.map((session) => session.sessionId),
      roles,
    );
    changed = true;
    placed = cards[ids.at(-1)?.sessionId ?? ''];
  }
  // Pais primeiro, para os filhos caírem embaixo deles.
  const ordered = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  for (const session of ordered) {
    if (cards[session.sessionId]) continue;
    placed = placeNew(session.sessionId, cards, roles, freeRects());
    cards[session.sessionId] = placed;
    changed = true;
  }
  if (changed) save();
  const waiting = focusWhenPlaced;
  if (waiting && cards[waiting]) {
    focusWhenPlaced = undefined;
    // Depois do render, quando o nó do cartão já existe.
    requestAnimationFrame(() => {
      focusSession(waiting);
    });
    return;
  }
  // Cartão novo fora da vista (vindo do chat, do café ou de uma tarefa) parecia
  // que não tinha aparecido; a visão vai até ele.
  if (placed && !inView(placed)) centerOn(placed);
}

/** Agente criado pela Mesa cuja sessão ainda não chegou na lista. */
let focusWhenPlaced: string | undefined;

function inView(rect: Rect): boolean {
  const box = viewport.getBoundingClientRect();
  const left = rect.x * view.zoom + view.x;
  const top = rect.y * view.zoom + view.y;
  return (
    left >= 0 &&
    top >= 56 &&
    left + rect.w * view.zoom <= box.width &&
    top + rect.h * view.zoom <= box.height - 90
  );
}

function render(): void {
  ensurePlaced();
  renderSidebar();
  renderUsage();
  renderExternal();
  renderCards();
  renderZones();
  renderRopes();
  renderAttention();
  renderEmpty();
  drawMinimap();
}

function renderSidebar(): void {
  const active = sessions.filter((s) => !['concluído', 'falhou', 'parado'].includes(s.state));
  const cost =
    usage?.total.custoUsd ??
    sessions.reduce(
      (sum, s) => sum + (s.usage.cost?.currency === 'USD' ? s.usage.cost.amount : 0),
      0,
    );
  const tokens = sessions.reduce((sum, s) => sum + s.usage.totalTokens, 0);
  summary.replaceChildren(
    stat(
      String(active.length),
      active.length === 1 ? l10n.t('active agent') : l10n.t('active agents'),
    ),
    stat(l10n.t('${0}', cost.toFixed(2)), l10n.t('today')),
    stat(tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens), 'tokens'),
  );

  const counts = new Map([...changes].map(([id, files]) => [id, files.length]));
  const floors = floorsOf(sessions, counts);
  floorsTitle.hidden = floors.length === 0;
  floorsList.replaceChildren(
    ...floors.map((floor) => {
      const li = el('li');
      const button = el('button', { type: 'button', class: `floor ${floor.state}` });
      button.append(
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'floor-name', title: floor.key }, floor.nome),
        el('span', { class: 'floor-state' }, floorLabel(floor.state)),
      );
      if (floor.arquivos > 0)
        button.append(el('span', { class: 'chip' }, l10n.t('Files: {0}', floor.arquivos)));
      button.addEventListener('click', () => {
        const area = bounds(floor.sessions.map((id) => cards[id]).filter(isRect));
        if (area) {
          const box = viewport.getBoundingClientRect();
          animateTo(fitView(area, box.width, box.height, 100));
        }
      });
      li.append(button);
      if (floor.worktree && floor.arquivos > 0) {
        const land = el(
          'button',
          {
            type: 'button',
            class: 'land',
            title: l10n.t('Review and apply the work on this floor'),
          },
          l10n.t('Land'),
        );
        land.addEventListener('click', () => {
          openSheet(floor);
        });
        li.append(land);
      }
      return li;
    }),
  );

  agentsTitle.hidden = sessions.length === 0;
  agentsList.replaceChildren(
    ...sessions.map((session) => {
      const li = el('li');
      const button = el('button', { type: 'button', class: `agent-row ${toneOf(session.state)}` });
      const avatar = el('span', { class: 'avatar small' });
      const profile = profileOf(session);
      paintAvatar(avatar, session.nome, profile?.provedor ?? session.provedor, 14);
      avatar.style.setProperty('--accent', accentOf(session));
      const role = roleOf(session.sessionId);
      button.append(
        avatar,
        el(
          'span',
          { class: 'agent-name' },
          role ? `${session.nome} · ${role.papel}` : session.nome,
        ),
        el('span', { class: 'agent-state' }, agentStateLabel(session.state)),
      );
      button.addEventListener('click', () => {
        focusSession(session.sessionId);
      });
      li.append(button);
      return li;
    }),
  );
}

function renderExternal(): void {
  externalEnable.hidden = external.ativo;
  externalNote.hidden = external.ativo && external.sessoes.length > 0;
  externalNote.textContent = external.ativo
    ? l10n.t('No recent conversations in the Codex or Claude Code extensions.')
    : l10n.t('Conversations from the Codex and Claude Code extensions, read-only.');
  externalList.replaceChildren(
    ...external.sessoes.map((session) => {
      const li = el('li');
      const row = el('div', {
        class: `agent-row external-row ${session.estado === 'ativa' ? 'busy' : ''}`,
        title: session.pasta,
      });
      const avatar = el('span', { class: 'avatar small' });
      paintAvatar(avatar, EXTERNAL_NAMES[session.fonte], session.provedor, 14);
      avatar.style.setProperty('--accent', accentFor(session.provedor));
      row.append(
        avatar,
        el('span', { class: 'agent-name' }, session.titulo ?? folderName(session.pasta)),
        el(
          'span',
          { class: 'agent-state' },
          `${EXTERNAL_NAMES[session.fonte]} · ${
            session.estado === 'ativa' ? l10n.t('active') : l10n.t('idle')
          }`,
        ),
        el('span', { class: 'chip external-chip' }, l10n.t('external')),
      );
      const open = el(
        'button',
        {
          type: 'button',
          class: 'land',
          title: l10n.t(
            'Open this conversation in its own extension; the Desk cannot send messages to it',
          ),
        },
        l10n.t('Open in extension'),
      );
      open.addEventListener('click', () => {
        post({ type: 'externasAbrir', id: session.id });
      });
      li.append(row, open);
      return li;
    }),
  );
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const RING = 2 * Math.PI * 15;
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

/** Um anel por provedor com o quanto do teto do dia já foi (o Maestri mostra igual). */
function renderUsage(): void {
  const entries = usage ? Object.entries(usage.porProvedor) : [];
  usageTitle.hidden = entries.length === 0;
  usageList.hidden = entries.length === 0;
  if (!usage) return;
  const summary = usage;
  usageList.replaceChildren(
    ...entries.map(([provedor, totals]) => {
      const ring = usageRing(
        provedor,
        totals,
        summary.tetos[provedor],
        summary.bloqueados.includes(provedor),
      );
      const li = el('li', { class: `ring-row${ring.bloqueado ? ' blocked' : ''}` });
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 36 36');
      svg.setAttribute('class', 'ring');
      svg.setAttribute('aria-hidden', 'true');
      const track = document.createElementNS(SVG_NS, 'circle');
      const arc = document.createElementNS(SVG_NS, 'circle');
      for (const circle of [track, arc]) {
        circle.setAttribute('cx', '18');
        circle.setAttribute('cy', '18');
        circle.setAttribute('r', '15');
      }
      track.setAttribute('class', 'ring-track');
      arc.setAttribute('class', 'ring-arc');
      arc.style.stroke = ring.bloqueado ? '#f87171' : accentFor(provedor);
      const fraction = ring.fracao ?? 1;
      arc.style.strokeDasharray = `${RING * fraction} ${RING}`;
      if (ring.fracao === undefined) arc.style.opacity = '0.35';
      svg.append(track, arc);
      const text = el('div', { class: 'ring-text' });
      text.append(
        el('span', { class: 'ring-name' }, PROVIDER_NAMES[provedor] ?? provedor),
        el(
          'span',
          { class: 'ring-value' },
          ring.bloqueado
            ? l10n.t('at the cap · {0}', ring.gasto)
            : ring.teto
              ? l10n.t('{0} of {1}', ring.gasto, ring.teto)
              : l10n.t('{0} · no cap', ring.gasto),
        ),
      );
      li.append(svg, text);
      if (ring.fracao !== undefined) {
        li.append(el('span', { class: 'ring-pct' }, `${Math.round(ring.fracao * 100)}%`));
      }
      return li;
    }),
  );
}

function stat(value: string, label: string): HTMLElement {
  const node = el('div', { class: 'stat' });
  node.append(el('strong', {}, value), el('span', {}, label));
  return node;
}

const cardNodes = new Map<string, HTMLElement>();

function renderCards(): void {
  const present = new Set<string>();
  for (const session of visibleCards()) {
    present.add(session.sessionId);
    let node = cardNodes.get(session.sessionId);
    if (!node) {
      node = buildCard(session.sessionId);
      cardNodes.set(session.sessionId, node);
      cardLayer.append(node);
    }
    updateCard(node, session);
  }
  for (const [id, node] of cardNodes) {
    if (!present.has(id)) {
      cancelarMicrofone(node);
      node.remove();
      cardNodes.delete(id);
    }
  }
  const noteIds = new Set(notes.map((n) => n.id));
  for (const node of [...cardLayer.querySelectorAll<HTMLElement>('.note')]) {
    if (!noteIds.has(node.dataset.id ?? '')) node.remove();
  }
  for (const note of notes) {
    let node = cardLayer.querySelector<HTMLElement>(`.note[data-id="${CSS.escape(note.id)}"]`);
    if (!node) {
      node = buildNote(note);
      cardLayer.append(node);
    }
    placeNode(node, note);
    node.classList.toggle('selected', selectedNote === note.id);
  }
  const portalIds = new Set(portals.map((p) => p.id));
  for (const node of [...cardLayer.querySelectorAll<HTMLElement>('.portal')]) {
    if (!portalIds.has(node.dataset.id ?? '')) node.remove();
  }
  for (const portal of portals) {
    let node = cardLayer.querySelector<HTMLElement>(`.portal[data-id="${CSS.escape(portal.id)}"]`);
    if (!node) {
      node = buildPortal(portal);
      cardLayer.append(node);
    }
    placeNode(node, portal);
    node.classList.toggle('selected', selectedNote === portal.id);
  }
}

function placeNode(node: HTMLElement, rect: Rect): void {
  if (node.parentElement === liftLayer) return;
  node.style.left = `${rect.x}px`;
  node.style.top = `${rect.y}px`;
  node.style.width = `${rect.w}px`;
  node.style.height = `${rect.h}px`;
}

function buildCard(sessionId: string): HTMLElement {
  const node = el('article', { class: 'card', 'data-id': sessionId });
  const header = el('header', { class: 'card-head' });
  const avatar = el('span', { class: 'avatar' });
  const titles = el('div', { class: 'titles' });
  const name = el('div', { class: 'name' });
  const sub = el('div', { class: 'sub' });
  titles.append(name, sub);
  const dot = el('span', { class: 'state-dot', 'aria-hidden': 'true' });
  const liftButton = el('button', {
    type: 'button',
    class: 'icon',
    title: l10n.t('Expand (double-click the title)'),
    'aria-label': l10n.t('Expand'),
  });
  liftButton.append(icon('M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6', 14));
  const more = el(
    'button',
    {
      type: 'button',
      class: 'icon',
      title: l10n.t('Agent menu'),
      'aria-label': l10n.t('Agent actions'),
    },
    '⋯',
  );
  // Terminal de leitura do agente (ADR 0046): o que ele faz, ao vivo, sem teclado.
  const terminalButton = el('button', {
    type: 'button',
    class: 'icon card-terminal',
    title: l10n.t('Live terminal (read-only)'),
    'aria-label': l10n.t('Terminal'),
  });
  terminalButton.append(icon('M4 17l6-6-6-6M12 19h8', 14));
  terminalButton.addEventListener('click', (event) => {
    post({ type: 'liveTerminal', sessionId });
    event.stopPropagation();
  });
  header.append(avatar, titles, dot, terminalButton, liftButton, more);

  const chips = el('div', { class: 'chips' });
  const body = el('div', { class: 'card-body', role: 'log', 'aria-live': 'polite' });
  const permission = el('div', { class: 'card-permission', hidden: '' });
  const filesBar = el('button', { type: 'button', class: 'card-files', hidden: '' });
  const composer = el('form', { class: 'card-composer' });
  const input = el('textarea', {
    rows: '1',
    placeholder: l10n.t('Message the agent…'),
    'aria-label': l10n.t('Message'),
  });
  input.value = drafts.get(sessionId) ?? '';
  const send = el('button', {
    type: 'submit',
    class: 'send',
    title: l10n.t('Send (Enter)'),
    'aria-label': l10n.t('Send'),
  });
  send.append(icon('M5 12h14M13 6l6 6-6 6', 16));
  const picker = el('ul', { class: 'picker', role: 'listbox', hidden: '' });
  const mic = criarMicrofone({
    campo: input,
    transcrever: (audio) => transcritor.transcrever(audio),
    onErro: showError,
    onConfigurar: () => {
      post({ type: 'vozConfigurar' });
    },
    title: true,
  });
  mic.definirStatus(vozStatus);
  microfones.set(mic.botao, mic);
  composer.append(picker, input, mic.botao, send);
  const resize = el('span', { class: 'resize', 'aria-hidden': 'true' });
  node.append(header, chips, body, permission, filesBar, composer, resize);

  const mentions = attachMentions(sessionId, input, picker);
  input.addEventListener('input', () => {
    drafts.set(sessionId, input.value);
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });
  input.addEventListener('keydown', (event) => {
    if (mentions.handleKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    post({
      type: 'send',
      sessionId,
      text: expandMentions(text, lastAnswers(sessionId)),
      shown: text,
    });
    input.value = '';
    drafts.delete(sessionId);
    input.style.height = 'auto';
  });
  header.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    toggleLift(sessionId);
  });
  liftButton.addEventListener('click', () => {
    toggleLift(sessionId);
  });
  more.addEventListener('click', (event) => {
    const box = more.getBoundingClientRect();
    openCardMenu(sessionId, box.left, box.bottom + 4);
    event.stopPropagation();
  });
  filesBar.addEventListener('click', () => {
    const floor = floorsOf(sessions, new Map([...changes].map(([id, f]) => [id, f.length]))).find(
      (f) => f.sessions.includes(sessionId),
    );
    if (floor) openSheet(floor);
  });
  dragHandle(header, sessionId, 'move');
  dragHandle(resize, sessionId, 'resize');
  node.addEventListener('pointerdown', () => {
    raise(node);
  });
  node.addEventListener('click', (event) => {
    if (tool === 'ligar') {
      event.stopPropagation();
      pickLink(sessionId);
    }
  });
  return node;
}

const TONES = ['idle', 'busy', 'attention', 'paused', 'done', 'failed'] as const;

let zTop = 1;
function raise(node: HTMLElement): void {
  node.style.zIndex = String(++zTop);
}

function updateCard(node: HTMLElement, session: AgentSessionInfo): void {
  const rect = cards[session.sessionId];
  if (rect) placeNode(node, rect);
  const tone = toneOf(session.state);
  // Só as classes de estado mudam: arrastar e piscar continuam no meio de uma atualização.
  for (const name of TONES) node.classList.toggle(name, name === tone);
  node.classList.toggle('lifted', lifted === session.sessionId);
  node.classList.toggle('linking', linkFrom === session.sessionId);
  node.style.setProperty('--accent', accentOf(session));
  const role = roleOf(session.sessionId);
  if (role) node.style.setProperty('--role', roleColor(role.papel));

  const avatar = node.querySelector<HTMLElement>('.avatar');
  const profile = profileOf(session);
  if (avatar) {
    paintAvatar(avatar, session.nome, profile?.provedor ?? session.provedor, 18);
  }
  const name = node.querySelector<HTMLElement>('.name');
  if (name) {
    name.replaceChildren(el('span', {}, session.nome));
    if (role) name.append(el('span', { class: 'role' }, role.papel));
  }
  const sub = node.querySelector<HTMLElement>('.sub');
  if (sub) {
    const where = session.worktree ? session.worktree.branch : l10n.t('open folder');
    sub.textContent = `${agentStateLabel(session.state)}${elapsed(session)} · ${where}`;
    sub.title = session.worktree?.path ?? session.cwd;
  }

  renderChips(node, session);
  renderBody(node, session.sessionId);

  const items = transcripts.get(session.sessionId) ?? [];
  const pending = items.findLast((item) => item.kind === 'permission' && !item.answer);
  const permission = node.querySelector<HTMLElement>('.card-permission');
  if (permission) {
    permission.hidden = pending?.kind !== 'permission';
    if (pending?.kind === 'permission') {
      permission.replaceChildren();
      const text = el('div', { class: 'perm-title' });
      text.append(
        el('span', { class: 'perm-label' }, l10n.t('Asks for permission')),
        el('code', pending.detail ? { title: pending.detail } : {}, pending.title),
      );
      const allow = el('button', { type: 'button', class: 'primary' }, l10n.t('Allow'));
      const deny = el('button', { type: 'button', class: 'ghost' }, l10n.t('Deny'));
      const answer = (value: boolean): void => {
        allow.disabled = true;
        deny.disabled = true;
        post({ type: 'permission', sessionId: session.sessionId, id: pending.id, allow: value });
      };
      allow.addEventListener('click', () => {
        answer(true);
      });
      deny.addEventListener('click', () => {
        answer(false);
      });
      const actions = el('div', { class: 'perm-actions' });
      actions.append(allow, deny);
      permission.append(text, actions);
    }
  }

  const files = changes.get(session.sessionId) ?? [];
  const filesBar = node.querySelector<HTMLButtonElement>('.card-files');
  if (filesBar) {
    filesBar.hidden = files.length === 0;
    filesBar.textContent =
      files.length === 1
        ? l10n.t('1 file changed · review')
        : l10n.t('{0} files changed · review', files.length);
  }

  const ended = ['concluído', 'falhou', 'parado'].includes(session.state);
  const composer = node.querySelector<HTMLFormElement>('.card-composer');
  // Encerrada mas guardada: uma mensagem nova retoma a sessão.
  if (composer) {
    composer.hidden = ended && session.retomavel !== true;
    if (composer.hidden) cancelarMicrofone(composer);
  }
  const input = node.querySelector<HTMLTextAreaElement>('textarea');
  if (input) {
    input.placeholder =
      tone === 'busy' || session.state === 'pausado'
        ? l10n.t('Queue a message…')
        : session.state === 'aguardando-você'
          ? l10n.t('Reply to the agent…')
          : l10n.t('Message the agent…');
  }
}

function renderChips(node: HTMLElement, session: AgentSessionInfo): void {
  const chips = node.querySelector<HTMLElement>('.chips');
  if (!chips) return;
  const ended =
    ['concluído', 'falhou', 'parado'].includes(session.state) && session.retomavel !== true;
  const focused = chips.contains(document.activeElement);
  if (focused) return;
  chips.replaceChildren();
  const rank = (categoria?: string): number =>
    categoria === 'model' ? 0 : categoria === 'thought_level' ? 1 : 2;
  for (const option of [...session.opcoes].sort((a, b) => rank(a.categoria) - rank(b.categoria))) {
    if (!option.valores) continue;
    const select = el('select', {
      class: 'chip-select',
      'aria-label': option.nome,
      title: option.descricao ?? option.nome,
    });
    for (const value of option.valores)
      select.append(el('option', { value: value.id }, value.nome));
    select.value = String(option.atual);
    select.disabled = ended;
    select.addEventListener('change', () => {
      post({ type: 'setOption', sessionId: session.sessionId, id: option.id, value: select.value });
    });
    chips.append(select);
  }
  const mode = el('select', {
    class: `chip-select mode ${session.permissoes}`,
    'aria-label': l10n.t('Permission mode'),
    title: l10n.t('Permission mode'),
  });
  for (const m of modes()) mode.append(el('option', { value: m.value }, m.label));
  mode.value = session.permissoes;
  mode.disabled = ended;
  mode.addEventListener('change', () => {
    post({
      type: 'setPermissions',
      sessionId: session.sessionId,
      permissions: mode.value as PermissionPolicyName,
    });
  });
  chips.append(mode);
  const cost = session.usage.cost;
  const tokens = session.usage.totalTokens;
  const usage = [
    tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k tok` : `${tokens} tok`,
    cost
      ? cost.currency === 'USD'
        ? l10n.t('${0}', cost.amount.toFixed(2))
        : `${cost.currency} ${cost.amount.toFixed(2)}`
      : '',
    session.contaClaude ? session.contaClaude.apelido : '',
  ]
    .filter(Boolean)
    .join(' · ');
  chips.append(el('span', { class: 'usage' }, usage));
}

const MAX_ITEMS = 60;

function renderBody(node: HTMLElement, sessionId: string): void {
  const body = node.querySelector<HTMLElement>('.card-body');
  if (!body) return;
  const items = transcripts.get(sessionId) ?? [];
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const shown = items.slice(-MAX_ITEMS);
  body.replaceChildren(...shown.map(renderItem));
  if (shown.length === 0) {
    body.append(el('div', { class: 'quiet' }, l10n.t('No messages yet. Write below to start.')));
  }
  if (nearBottom || body.dataset.init !== '1') {
    body.scrollTop = body.scrollHeight;
    body.dataset.init = '1';
  }
}

function renderItem(item: ChatItem): HTMLElement {
  switch (item.kind) {
    case 'user':
      return el('div', { class: 'msg user' }, item.text);
    case 'agent': {
      const node = el('div', { class: 'msg agent' });
      node.innerHTML = renderMarkdown(item.text);
      return node;
    }
    case 'thought': {
      const node = el('details', { class: 'thought' });
      node.append(el('summary', {}, l10n.t('Reasoning')), el('div', {}, item.text));
      return node;
    }
    case 'tool': {
      const node = el('div', { class: `tool ${item.status ?? 'pending'}` });
      const mark = item.status === 'completed' ? '✓' : item.status === 'failed' ? '✕' : '›';
      node.innerHTML = `<span class="tool-mark">${mark}</span>${escapeHtml(item.title)}`;
      return node;
    }
    case 'permission':
      return el(
        'div',
        { class: `tool perm ${item.answer ?? 'pending'}` },
        `${item.answer === 'negado' ? '✕' : item.answer ? '✓' : '?'} ${item.title}`,
      );
    case 'notice':
      return el('div', { class: `notice ${item.tone}` }, item.text);
  }
}

function buildNote(note: MesaNote): HTMLElement {
  const node = el('div', { class: 'note', 'data-id': note.id });
  const head = el('div', { class: 'note-head' });
  head.append(el('span', {}, l10n.t('Note')));
  const remove = el(
    'button',
    {
      type: 'button',
      class: 'icon',
      title: l10n.t('Delete note'),
      'aria-label': l10n.t('Delete note'),
    },
    '×',
  );
  head.append(remove);
  const body = el('div', { class: 'note-body' });
  const editor = el('textarea', {
    class: 'note-editor',
    hidden: '',
    'aria-label': l10n.t('Note text (Markdown)'),
  });
  const resize = el('span', { class: 'resize', 'aria-hidden': 'true' });
  node.append(head, body, editor, resize);
  const showText = (): void => {
    const current = notes.find((n) => n.id === note.id);
    body.innerHTML = current?.text
      ? renderMarkdown(current.text)
      : `<p class="quiet">${escapeHtml(l10n.t('Double-click to write. Markdown works.'))}</p>`;
  };
  showText();
  const edit = (): void => {
    editor.value = notes.find((n) => n.id === note.id)?.text ?? '';
    editor.hidden = false;
    body.hidden = true;
    editor.focus();
  };
  body.addEventListener('dblclick', edit);
  editor.addEventListener('blur', () => {
    notes = notes.map((n) => (n.id === note.id ? { ...n, text: editor.value } : n));
    editor.hidden = true;
    body.hidden = false;
    showText();
    save();
  });
  remove.addEventListener('click', () => {
    deleteNote(note.id);
  });
  node.addEventListener('pointerdown', () => {
    selectedNote = note.id;
    raise(node);
    for (const other of cardLayer.querySelectorAll('.note.selected'))
      other.classList.remove('selected');
    node.classList.add('selected');
  });
  node.addEventListener('click', (event) => {
    if (tool === 'ligar') {
      event.stopPropagation();
      pickLink(note.id);
    }
  });
  dragHandle(head, note.id, 'move');
  dragHandle(resize, note.id, 'resize');
  if (!note.text) setTimeout(edit, 0);
  return node;
}

function deleteNote(id: string): void {
  notes = notes.filter((n) => n.id !== id);
  portals = portals.filter((p) => p.id !== id);
  links = links.filter((l) => l.from !== id && l.to !== id);
  if (selectedNote === id) selectedNote = undefined;
  render();
  save();
}

function rectOf(id: string): Rect | undefined {
  return cards[id] ?? notes.find((n) => n.id === id) ?? portals.find((p) => p.id === id);
}

/** Prévia do app na mesa: um navegador pequeno com endereço, recarregar e abrir fora. */
function buildPortal(portal: MesaPortal): HTMLElement {
  const node = el('div', { class: 'portal', 'data-id': portal.id });
  const head = el('div', { class: 'portal-head' });
  head.append(icon('M3 5h18v14H3zM3 9h18', 14));
  const address = el('input', {
    class: 'portal-url',
    'aria-label': l10n.t('Preview address'),
    spellcheck: 'false',
  });
  address.value = portal.url;
  const reload = el(
    'button',
    { type: 'button', class: 'icon', title: l10n.t('Reload'), 'aria-label': l10n.t('Reload') },
    '↻',
  );
  const external = el('button', {
    type: 'button',
    class: 'icon',
    title: l10n.t('Open in browser'),
    'aria-label': l10n.t('Open in browser'),
  });
  external.append(icon('M14 4h6v6M20 4l-9 9M18 14v6H4V6h6', 14));
  const remove = el(
    'button',
    {
      type: 'button',
      class: 'icon',
      title: l10n.t('Close preview'),
      'aria-label': l10n.t('Close preview'),
    },
    '×',
  );
  head.append(address, reload, external, remove);
  const frame = el('iframe', {
    class: 'portal-frame',
    title: l10n.t('Preview'),
    sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups',
    src: portal.url,
  });
  // O iframe engole o ponteiro; durante arrastos, uma capa deixa a mesa receber.
  const shield = el('div', { class: 'portal-shield' });
  const resize = el('span', { class: 'resize', 'aria-hidden': 'true' });
  node.append(head, frame, shield, resize);
  const go = (): void => {
    const url = portalUrl(address.value);
    if (!url) {
      showError(l10n.t('Invalid address. Use http://localhost:3000 or an https URL.'));
      return;
    }
    address.value = url;
    frame.src = url;
    portals = portals.map((p) => (p.id === portal.id ? { ...p, url } : p));
    save();
  };
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  reload.addEventListener('click', () => {
    frame.src = portals.find((p) => p.id === portal.id)?.url ?? portal.url;
  });
  external.addEventListener('click', () => {
    post({ type: 'openExternal', url: portals.find((p) => p.id === portal.id)?.url ?? portal.url });
  });
  remove.addEventListener('click', () => {
    deleteNote(portal.id);
  });
  node.addEventListener('pointerdown', () => {
    selectedNote = portal.id;
    raise(node);
  });
  node.addEventListener('click', (event) => {
    if (tool === 'ligar') {
      event.stopPropagation();
      pickLink(portal.id);
    }
  });
  dragHandle(head, portal.id, 'move');
  dragHandle(resize, portal.id, 'resize');
  return node;
}

function addPortal(at: { x: number; y: number }): void {
  const portal: MesaPortal = {
    id: `previa-${Date.now().toString(36)}`,
    x: snap(at.x),
    y: snap(at.y),
    w: PORTAL_W,
    h: PORTAL_H,
    url: 'http://localhost:3000/',
  };
  portals = [...portals, portal];
  selectedNote = portal.id;
  render();
  save();
  const input = cardLayer.querySelector<HTMLInputElement>(
    `.portal[data-id="${CSS.escape(portal.id)}"] .portal-url`,
  );
  input?.focus();
  input?.select();
}

/** Última resposta de cada outro agente, pelo nome, para expandir as menções @. */
function lastAnswers(except: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const session of sessions) {
    if (session.sessionId === except) continue;
    const last = (transcripts.get(session.sessionId) ?? []).findLast(
      (item) => item.kind === 'agent',
    );
    if (last?.kind === 'agent') answers.set(session.nome, last.text);
  }
  return answers;
}

let fileRequest = 0;
const fileWaiters = new Map<number, (files: readonly string[]) => void>();

function requestFiles(query: string): Promise<readonly string[]> {
  const requestId = ++fileRequest;
  post({ type: 'findFiles', requestId, query });
  return new Promise((resolve) => {
    fileWaiters.set(requestId, resolve);
    setTimeout(() => {
      if (fileWaiters.delete(requestId)) resolve([]);
    }, 3000);
  });
}

/**
 * Composer com menções: @ lista os outros agentes (a resposta deles vai junto
 * com a mensagem) e # lista os arquivos da pasta.
 */
function attachMentions(
  sessionId: string,
  input: HTMLTextAreaElement,
  picker: HTMLUListElement,
): { handleKey(event: KeyboardEvent): boolean } {
  let options: { label: string; insert: string; detail?: string }[] = [];
  let active = 0;
  let start = 0;
  let seq = 0;

  const close = (): void => {
    picker.hidden = true;
    options = [];
  };
  const draw = (): void => {
    picker.replaceChildren(
      ...options.map((option, index) => {
        const li = el('li', {
          role: 'option',
          class: index === active ? 'active' : '',
          'aria-selected': String(index === active),
        });
        li.append(el('span', {}, option.label));
        if (option.detail) li.append(el('span', { class: 'picker-detail' }, option.detail));
        li.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          active = index;
          choose();
        });
        return li;
      }),
    );
    picker.hidden = options.length === 0;
  };
  const choose = (): void => {
    const option = options[active];
    if (!option) return;
    const caret = input.selectionStart;
    input.value = `${input.value.slice(0, start)}${option.insert} ${input.value.slice(caret)}`;
    const next = start + option.insert.length + 1;
    input.setSelectionRange(next, next);
    drafts.set(sessionId, input.value);
    close();
  };
  const update = async (): Promise<void> => {
    const found = mentionAt(input.value, input.selectionStart);
    if (!found) {
      close();
      return;
    }
    start = found.start;
    const query = found.query.toLowerCase();
    const mine = ++seq;
    if (found.kind === '@') {
      // Quem começa com o que foi digitado vem primeiro.
      const rank = (nome: string): number => (nome.toLowerCase().startsWith(query) ? 0 : 1);
      options = sessions
        .filter((s) => s.sessionId !== sessionId && s.nome.toLowerCase().includes(query))
        .sort((a, b) => rank(a.nome) - rank(b.nome))
        .map((s) => ({
          label: s.nome,
          insert: `@${s.nome}`,
          detail: roleOf(s.sessionId)?.papel ?? agentStateLabel(s.state),
        }));
    } else {
      const files = await requestFiles(found.query);
      if (mine !== seq) return;
      options = files.map((file) => ({ label: file, insert: `#${file}` }));
    }
    active = 0;
    draw();
  };
  input.addEventListener('input', () => void update());
  input.addEventListener('blur', () => {
    setTimeout(close, 150);
  });
  return {
    handleKey(event: KeyboardEvent): boolean {
      if (picker.hidden || options.length === 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + options.length) % options.length;
        draw();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose();
        return true;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return true;
      }
      return false;
    },
  };
}

function renderZones(): void {
  const counts = new Map([...changes].map(([id, files]) => [id, files.length]));
  zones.replaceChildren();
  for (const floor of floorsOf(sessions, counts)) {
    if (!floor.worktree) continue;
    const area = bounds(floor.sessions.map((id) => cards[id]).filter(isRect));
    if (!area) continue;
    const pad = 28;
    const zone = el('div', { class: `zone ${floor.state}` });
    zone.style.left = `${area.x - pad}px`;
    zone.style.top = `${area.y - pad - 14}px`;
    zone.style.width = `${area.w + pad * 2}px`;
    zone.style.height = `${area.h + pad * 2 + 14}px`;
    zone.append(
      el(
        'span',
        { class: 'zone-label' },
        l10n.t('floor · {0} · {1}', floor.nome, floorLabel(floor.state).toLowerCase()),
      ),
    );
    zones.append(zone);
  }
}

function renderRopes(): void {
  ropes.replaceChildren();
  const draw = (a: Rect, b: Rect, cls: string, color: string, onClick?: () => void): void => {
    const d = ropePath(a, b);
    const glow = document.createElementNS(SVG_NS, 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('class', 'rope-glow');
    glow.style.stroke = color;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `rope ${cls}`);
    path.style.stroke = color;
    ropes.append(glow, path);
    if (onClick) {
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'rope-hit');
      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      ropes.append(hit);
    }
    for (const [x, y] of endpoints(d)) {
      const plug = document.createElementNS(SVG_NS, 'circle');
      plug.setAttribute('cx', String(x));
      plug.setAttribute('cy', String(y));
      plug.setAttribute('r', '4');
      plug.setAttribute('class', 'plug');
      plug.style.fill = color;
      ropes.append(plug);
    }
  };
  for (const role of roles) {
    if (!role.parentSessionId) continue;
    const a = cards[role.parentSessionId];
    const b = cards[role.sessionId];
    const child = sessions.find((s) => s.sessionId === role.sessionId);
    if (!a || !b || !child || !sessions.some((s) => s.sessionId === role.parentSessionId)) continue;
    draw(a, b, toneOf(child.state), roleColor(role.papel));
  }
  for (const link of links) {
    const a = rectOf(link.from);
    const b = rectOf(link.to);
    if (!a || !b) continue;
    draw(
      a,
      b,
      'user',
      '#64748b',
      tool === 'ligar'
        ? () => {
            removeLink(link);
          }
        : undefined,
    );
  }
}

function endpoints(d: string): [number, number][] {
  const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const [x1 = 0, y1 = 0] = numbers;
  const x2 = numbers.at(-2) ?? 0;
  const y2 = numbers.at(-1) ?? 0;
  return [
    [x1, y1],
    [x2, y2],
  ];
}

function removeLink(link: MesaLink): void {
  links = links.filter((l) => l !== link);
  renderRopes();
  save();
}

function pickLink(id: string): void {
  if (!linkFrom) {
    linkFrom = id;
    showHint(l10n.t('Now click the target card. Esc cancels.'));
    render();
    return;
  }
  if (
    linkFrom !== id &&
    !links.some((l) => (l.from === linkFrom && l.to === id) || (l.from === id && l.to === linkFrom))
  ) {
    links = [...links, { from: linkFrom, to: id }];
    save();
  }
  linkFrom = undefined;
  showHint(l10n.t('Cable connected. Click a cable to remove it.'));
  render();
}

function renderAttention(): void {
  const queue = attentionQueue(sessions);
  attentionButton.hidden = queue.length === 0;
  attentionButton.textContent =
    queue.length === 1
      ? l10n.t('1 agent is waiting for you')
      : l10n.t('{0} agents are waiting for you', queue.length);
  const badge = toolButtons.get('atencao');
  if (badge) badge.dataset.count = queue.length > 0 ? String(queue.length) : '';
}

function renderEmpty(): void {
  empty.hidden = sessions.length > 0 || freeRects().length > 0;
  if (empty.hidden) return;
  empty.replaceChildren();
  empty.append(
    el('div', { class: 'empty-logo', 'aria-hidden': 'true' }, '>_'),
    el('h1', {}, l10n.t('The Desk is empty')),
  );
  if (!hasFolder) {
    empty.append(el('p', {}, l10n.t('Open a project folder for the agents to work in.')));
    return;
  }
  empty.append(
    el(
      'p',
      {},
      l10n.t(
        'Put an agent on the desk to chat with it, or give the maestro a task and watch the subagents show up connected to it.',
      ),
    ),
  );
  const actions = el('div', { class: 'empty-actions' });
  for (const profile of profiles.filter((p) => p.availability.status === 'pronto')) {
    const button = el('button', { type: 'button', class: 'profile-button' });
    const avatar = el('span', { class: 'avatar small' });
    paintAvatar(avatar, profile.nome, profile.provedor, 14);
    avatar.style.setProperty('--accent', accentFor(profile.provedor));
    button.append(
      avatar,
      el(
        'span',
        {},
        starting === profile.nome ? l10n.t('Opening {0}…', profile.nome) : profile.nome,
      ),
    );
    button.disabled = starting !== undefined;
    button.addEventListener('click', () => {
      startAgent(profile.id);
    });
    actions.append(button);
  }
  const task = el(
    'button',
    { type: 'button', class: 'primary' },
    l10n.t('New task for the maestro'),
  );
  task.addEventListener('click', () => {
    post({ type: 'command', command: 'tarefa' });
  });
  empty.append(actions, task);
}

// ---- Minimapa -------------------------------------------------------------

function drawMinimap(): void {
  const ctx = minimap.getContext('2d');
  if (!ctx) return;
  const rects = [...sessions.map((s) => cards[s.sessionId]).filter(isRect), ...freeRects()];
  const box = viewport.getBoundingClientRect();
  const visible: Rect = {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    w: box.width / view.zoom,
    h: box.height / view.zoom,
  };
  const area = bounds([...rects, visible]);
  ctx.clearRect(0, 0, minimap.width, minimap.height);
  minimap.hidden = rects.length === 0;
  if (!area) return;
  const scale = Math.min((minimap.width - 16) / area.w, (minimap.height - 16) / area.h);
  const ox = 8 - area.x * scale + (minimap.width - 16 - area.w * scale) / 2;
  const oy = 8 - area.y * scale + (minimap.height - 16 - area.h * scale) / 2;
  minimap.dataset.scale = String(scale);
  minimap.dataset.ox = String(ox);
  minimap.dataset.oy = String(oy);
  for (const session of sessions) {
    const r = cards[session.sessionId];
    if (!r) continue;
    ctx.fillStyle = toneOf(session.state) === 'attention' ? '#fbbf24' : accentOf(session);
    ctx.globalAlpha = 0.8;
    ctx.fillRect(
      ox + r.x * scale,
      oy + r.y * scale,
      Math.max(2, r.w * scale),
      Math.max(2, r.h * scale),
    );
  }
  ctx.fillStyle = '#94a3b8';
  for (const n of freeRects()) {
    ctx.fillRect(ox + n.x * scale, oy + n.y * scale, n.w * scale, n.h * scale);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#e6edf3';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    ox + visible.x * scale,
    oy + visible.y * scale,
    visible.w * scale,
    visible.h * scale,
  );
}

minimap.addEventListener('pointerdown', (event) => {
  const scale = Number(minimap.dataset.scale);
  if (!scale) return;
  const move = (e: PointerEvent): void => {
    const box = minimap.getBoundingClientRect();
    const wx = (e.clientX - box.left - Number(minimap.dataset.ox)) / scale;
    const wy = (e.clientY - box.top - Number(minimap.dataset.oy)) / scale;
    const vp = viewport.getBoundingClientRect();
    view = { zoom: view.zoom, x: vp.width / 2 - wx * view.zoom, y: vp.height / 2 - wy * view.zoom };
    applyView();
  };
  move(event);
  minimap.setPointerCapture(event.pointerId);
  minimap.addEventListener('pointermove', move);
  minimap.addEventListener(
    'pointerup',
    () => {
      minimap.removeEventListener('pointermove', move);
      save();
    },
    { once: true },
  );
});

// ---- Arrastar, redimensionar, pan ----------------------------------------

function dragHandle(handle: HTMLElement, id: string, mode: 'move' | 'resize'): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || tool === 'ligar' || spaceDown || tool === 'mover') return;
    if ((event.target as HTMLElement).closest('button, select, textarea, input')) return;
    if (lifted === id) return;
    const start = rectOf(id);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const ox = event.clientX;
    const oy = event.clientY;
    handle.setPointerCapture(event.pointerId);
    const node = handle.closest<HTMLElement>('.card, .note, .portal');
    node?.classList.add('dragging');
    const move = (e: PointerEvent): void => {
      const dx = (e.clientX - ox) / view.zoom;
      const dy = (e.clientY - oy) / view.zoom;
      const next: Rect =
        mode === 'move'
          ? { ...start, x: snap(start.x + dx), y: snap(start.y + dy) }
          : {
              ...start,
              w: Math.max(240, snap(start.w + dx)),
              h: Math.max(140, snap(start.h + dy)),
            };
      setRect(id, next);
      if (node) placeNode(node, next);
      renderRopes();
      renderZones();
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      node?.classList.remove('dragging');
      drawMinimap();
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}

function setRect(id: string, rect: Rect): void {
  if (cards[id]) cards = { ...cards, [id]: rect };
  else {
    notes = notes.map((n) => (n.id === id ? { ...n, ...rect } : n));
    portals = portals.map((p) => (p.id === id ? { ...p, ...rect } : p));
  }
}

let spaceDown = false;

viewport.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  const onBackground =
    target === viewport ||
    target === world ||
    target === cardLayer ||
    target === zones ||
    target.classList.contains('zone');
  closeMenu();
  const pan =
    event.button === 1 ||
    spaceDown ||
    tool === 'mover' ||
    (event.button === 0 && onBackground && tool === 'selecionar');
  if (pan) {
    event.preventDefault();
    if (onBackground) selectedNote = undefined;
    const ox = event.clientX - view.x;
    const oy = event.clientY - view.y;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
    const move = (e: PointerEvent): void => {
      view = { ...view, x: e.clientX - ox, y: e.clientY - oy };
      applyView();
    };
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener(
      'pointerup',
      () => {
        viewport.removeEventListener('pointermove', move);
        viewport.classList.remove('panning');
        save();
      },
      { once: true },
    );
    return;
  }
  if (event.button !== 0 || !onBackground) return;
  const at = toWorld(event.clientX, event.clientY);
  if (tool === 'nota') {
    addNote(at);
    setTool('selecionar');
  } else if (tool === 'previa') {
    addPortal(at);
    setTool('selecionar');
  } else if (tool === 'agente') {
    // Sem isto o mesmo pointerdown chega ao document e fecha o menu na hora.
    event.stopPropagation();
    openAddMenu(event.clientX, event.clientY, at, true);
  } else if (tool === 'ligar') {
    linkFrom = undefined;
    render();
  }
});

// Focar um campo dentro da mesa faria o navegador rolar o viewport; a posição
// é só a da visão (pan), então a rolagem volta a zero.
viewport.addEventListener('scroll', () => {
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
});

viewport.addEventListener(
  'wheel',
  (event) => {
    const target = event.target as HTMLElement;
    const scrollable = target.closest('.card-body, .note-body, textarea, select');
    if (scrollable && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX, event.clientY);
    } else {
      view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
      applyView();
      save();
    }
  },
  { passive: false },
);

viewport.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('.card, .note, .portal')) return;
  event.preventDefault();
  openAddMenu(event.clientX, event.clientY, toWorld(event.clientX, event.clientY), false);
});

// ---- Menus, folha de pouso, Lift ----------------------------------------

function positionMenu(x: number, y: number): void {
  const box = stage.getBoundingClientRect();
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.min(x - box.left, box.width - width - 8)}px`;
  menu.style.top = `${Math.min(y - box.top, box.height - height - 8)}px`;
}

function menuItem(
  label: string,
  action: () => void,
  detail?: string,
  danger = false,
): HTMLButtonElement {
  const button = el('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '' });
  button.append(el('span', {}, label));
  if (detail) button.append(el('kbd', {}, detail));
  button.addEventListener('click', () => {
    closeMenu();
    action();
  });
  return button;
}

function openAddMenu(
  x: number,
  y: number,
  at: { x: number; y: number },
  agentsOnly: boolean,
): void {
  menu.replaceChildren(el('div', { class: 'menu-title' }, l10n.t('Add to the desk')));
  const ready = profiles.filter((p) => p.availability.status === 'pronto');
  if (!hasFolder)
    menu.append(el('div', { class: 'menu-note' }, l10n.t('Open a folder to place agents.')));
  else if (ready.length === 0)
    menu.append(el('div', { class: 'menu-note' }, l10n.t('No agents installed.')));
  for (const profile of ready) {
    const item = menuItem(l10n.t('Agent: {0}', profile.nome), () => {
      startAgent(profile.id, at);
    });
    const avatar = el('span', { class: 'avatar tiny' });
    paintAvatar(avatar, profile.nome, profile.provedor, 11);
    avatar.style.setProperty('--accent', accentFor(profile.provedor));
    item.prepend(avatar);
    menu.append(item);
  }
  if (!agentsOnly) {
    menu.append(
      el('hr'),
      menuItem(
        l10n.t('Note'),
        () => {
          addNote(at);
        },
        'O',
      ),
      menuItem(
        l10n.t('App preview'),
        () => {
          addPortal(at);
        },
        'P',
      ),
      menuItem(
        l10n.t('Task for the maestro'),
        () => {
          post({ type: 'command', command: 'tarefa' });
        },
        'T',
      ),
      el('hr'),
      menuItem(l10n.t('Arrange as a tree'), arrange, 'R'),
      menuItem(l10n.t('Fit all'), fitAll, 'F'),
    );
  }
  const worktree = el('label', { class: 'menu-check' });
  const box = el('input', { type: 'checkbox' });
  box.checked = startInWorktree;
  box.addEventListener('change', () => {
    startInWorktree = box.checked;
  });
  worktree.append(box, ` ${l10n.t('In its own worktree (your files stay unchanged)')}`);
  menu.append(worktree);
  positionMenu(x, y);
}

let startInWorktree = true;

/** Nome do agente que está subindo; enquanto isso, outro clique não cria mais um. */
let starting: string | undefined;

function startAgent(profileId: string, at?: { x: number; y: number }): void {
  setTool('selecionar');
  if (starting) {
    showHint(l10n.t('Still opening {0}…', starting), true);
    return;
  }
  starting = profiles.find((p) => p.id === profileId)?.nome ?? profileId;
  post({ type: 'start', profileId, worktree: startInWorktree, ...(at ? { at } : {}) });
  // O agente leva de 1 s a vários para subir; o aviso fica até ele chegar.
  showHint(l10n.t('Opening {0}… this may take a few seconds.', starting), true);
  renderEmpty();
}

function startEnded(): void {
  if (!starting) return;
  starting = undefined;
  hideHint();
  renderEmpty();
}

function openCardMenu(sessionId: string, x: number, y: number): void {
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return;
  const ended = ['concluído', 'falhou', 'parado'].includes(session.state);
  menu.replaceChildren(el('div', { class: 'menu-title' }, session.nome));
  if (!ended) {
    menu.append(
      session.state === 'pausado'
        ? menuItem(l10n.t('Resume'), () => {
            post({ type: 'resume', sessionId });
          })
        : menuItem(l10n.t('Pause'), () => {
            post({ type: 'pause', sessionId });
          }),
    );
  }
  menu.append(
    menuItem(
      l10n.t('Expand'),
      () => {
        toggleLift(sessionId);
      },
      l10n.t('double-click'),
    ),
    menuItem(l10n.t('Open in the side chat'), () => {
      post({ type: 'openChat', sessionId });
    }),
    menuItem(l10n.t('Live terminal (read-only)'), () => {
      post({ type: 'liveTerminal', sessionId });
    }),
    menuItem(l10n.t('Terminal in the agent’s folder'), () => {
      post({ type: 'terminal', sessionId });
    }),
    menuItem(l10n.t('View log'), () => {
      post({ type: 'log', sessionId });
    }),
  );
  if (session.worktree)
    menu.append(
      menuItem(l10n.t('Changed files'), () => {
        post({ type: 'changes', sessionId });
      }),
    );
  if (!ended)
    menu.append(
      el('hr'),
      menuItem(
        l10n.t('Stop agent'),
        () => {
          post({ type: 'stop', sessionId });
        },
        undefined,
        true,
      ),
    );
  positionMenu(x, y);
}

function closeMenu(): void {
  menu.hidden = true;
}

const STATUS_LETTER: Record<AgentChangedFile['status'], string> = {
  adicionado: 'A',
  modificado: 'M',
  removido: 'D',
};

function openSheet(floor: Floor): void {
  landing = floor.key;
  renderSheet();
}

function renderSheet(): void {
  if (!landing) {
    sheet.hidden = true;
    return;
  }
  const counts = new Map([...changes].map(([id, files]) => [id, files.length]));
  const floor = floorsOf(sessions, counts).find((f) => f.key === landing);
  if (!floor) {
    landing = undefined;
    sheet.hidden = true;
    return;
  }
  sheet.hidden = false;
  sheet.replaceChildren();
  const head = el('div', { class: 'sheet-head' });
  const close = el('button', { type: 'button', class: 'icon', 'aria-label': l10n.t('Close') }, '×');
  close.addEventListener('click', () => {
    landing = undefined;
    renderSheet();
  });
  const title = el('div');
  title.append(
    el('div', { class: 'eyebrow' }, l10n.t('Land floor')),
    el('h2', {}, floor.nome),
    el('div', { class: `floor-state ${floor.state}` }, floorLabel(floor.state)),
  );
  head.append(title, close);
  sheet.append(head);
  for (const sessionId of floor.sessions) {
    const files = changes.get(sessionId) ?? [];
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session || files.length === 0) continue;
    const group = el('section', { class: 'sheet-group' });
    group.append(
      el(
        'h3',
        {},
        files.length === 1
          ? l10n.t('{0} · 1 file', session.nome)
          : l10n.t('{0} · {1} files', session.nome, files.length),
      ),
    );
    const list = el('ul', { class: 'files' });
    for (const file of files) {
      const li = el('li');
      const open = el('button', { type: 'button', class: 'file', title: l10n.t('View the diff') });
      open.append(
        el('span', { class: `status ${file.status}` }, STATUS_LETTER[file.status]),
        el('span', { class: 'path' }, file.path),
      );
      open.addEventListener('click', () => {
        post({ type: 'openDiff', sessionId, path: file.path });
      });
      li.append(open);
      list.append(li);
    }
    const actions = el('div', { class: 'sheet-actions' });
    const apply = el('button', { type: 'button', class: 'primary' }, l10n.t('Apply to my folder'));
    apply.addEventListener('click', () => {
      post({ type: 'applyFiles', sessionId, paths: files.map((f) => f.path) });
    });
    const reject = el('button', { type: 'button', class: 'ghost' }, l10n.t('Discard'));
    reject.addEventListener('click', () => {
      post({ type: 'rejectFiles', sessionId, paths: files.map((f) => f.path) });
    });
    actions.append(apply, reject);
    group.append(list, actions);
    sheet.append(group);
  }
  sheet.append(
    el(
      'p',
      { class: 'sheet-note' },
      l10n.t(
        'Applying merges the worktree changes into your files; anything that would conflict gets markers for you to resolve. To open a PR, ask the maestro for a task with PR delivery.',
      ),
    ),
  );
}

function toggleLift(sessionId: string): void {
  const node = cardNodes.get(sessionId);
  if (!node) return;
  if (lifted === sessionId) {
    lifted = undefined;
    liftLayer.hidden = true;
    node.classList.remove('lifted');
    node.style.cssText = '';
    cardLayer.append(node);
    const rect = cards[sessionId];
    if (rect) placeNode(node, rect);
    return;
  }
  if (lifted) toggleLift(lifted);
  lifted = sessionId;
  liftLayer.hidden = false;
  node.classList.add('lifted');
  node.style.cssText = '';
  liftLayer.append(node);
  node.querySelector('textarea')?.focus();
}

liftLayer.addEventListener('pointerdown', (event) => {
  if (event.target === liftLayer && lifted) toggleLift(lifted);
});

// ---- Ferramentas e atalhos ----------------------------------------------

function setTool(next: Tool): void {
  tool = next;
  linkFrom = undefined;
  root.dataset.tool = next;
  for (const [id, button] of toolButtons) button.classList.toggle('active', id === next);
  if (next === 'agente') showHint(l10n.t('Click the desk where the agent should go.'));
  else if (next === 'nota') showHint(l10n.t('Click the desk to place the note.'));
  else if (next === 'previa') showHint(l10n.t('Click the desk to open the app preview.'));
  else if (next === 'ligar') showHint(l10n.t('Click two cards to connect them.'));
  else hideHint();
  renderRopes();
}

function runTool(id: ToolInfo['id']): void {
  switch (id) {
    case 'tarefa':
      post({ type: 'command', command: 'tarefa' });
      return;
    case 'enquadrar':
      fitAll();
      return;
    case 'arrumar':
      arrange();
      return;
    case 'atencao':
      nextAttention();
      return;
    default:
      setTool(tool === id && id !== 'selecionar' ? 'selecionar' : id);
  }
}

function arrange(): void {
  const ids = [...sessions]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((s) => s.sessionId);
  const placed = tidy(ids, roles);
  cards = { ...cards, ...placed };
  const area = bounds(Object.values(placed));
  if (area) {
    // Notas e prévias numa fileira embaixo dos agentes.
    let x = area.x;
    const y = snap(area.y + area.h + 80);
    const line = <T extends Rect>(item: T): T => {
      const moved = { ...item, x: snap(x), y };
      x += item.w + 40;
      return moved;
    };
    notes = notes.map(line);
    portals = portals.map(line);
  }
  world.classList.add('gliding');
  render();
  setTimeout(() => {
    world.classList.remove('gliding');
    fitAll();
  }, 50);
  save();
}

function nextAttention(): void {
  const queue = attentionQueue(sessions);
  if (queue.length === 0) {
    showHint(l10n.t('No one is waiting for you right now.'));
    return;
  }
  attentionIndex = attentionIndex % queue.length;
  const id = queue[attentionIndex];
  attentionIndex++;
  if (id) focusSession(id);
}

function focusSession(sessionId: string): void {
  const rect = cards[sessionId];
  if (!rect) return;
  centerOn(rect);
  const node = cardNodes.get(sessionId);
  if (node) {
    raise(node);
    node.classList.remove('flash');
    // Força o recálculo para a animação recomeçar.
    node.getBoundingClientRect();
    node.classList.add('flash');
    setTimeout(
      () => node.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }),
      330,
    );
  }
}

attentionButton.addEventListener('click', nextAttention);
zoomIn.addEventListener('click', () => {
  zoomAt(1.2);
});
zoomOut.addEventListener('click', () => {
  zoomAt(1 / 1.2);
});
zoomLabel.addEventListener('click', () => {
  zoomAt(1 / view.zoom);
});

function addNote(at: { x: number; y: number }): void {
  const note: MesaNote = {
    id: `nota-${Date.now().toString(36)}`,
    x: snap(at.x),
    y: snap(at.y),
    w: NOTE_W,
    h: NOTE_H,
    text: '',
  };
  notes = [...notes, note];
  selectedNote = note.id;
  render();
  save();
}

const KEYS: Record<string, ToolInfo['id']> = {
  v: 'selecionar',
  h: 'mover',
  n: 'agente',
  t: 'tarefa',
  o: 'nota',
  p: 'previa',
  l: 'ligar',
  a: 'atencao',
  r: 'arrumar',
  f: 'enquadrar',
};

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]')
  );
}

window.addEventListener('keydown', (event) => {
  if (ehAtalhoDeVoz(event)) {
    // Dita no cartão em que você está escrevendo.
    const botao = (event.target as HTMLElement | null)
      ?.closest('.card-composer')
      ?.querySelector<HTMLButtonElement>('.voz-mic');
    const mic = botao ? microfones.get(botao) : undefined;
    if (mic) {
      event.preventDefault();
      mic.alternar();
    }
    return;
  }
  if (event.key === 'Escape') {
    if (!menu.hidden) closeMenu();
    else if (lifted) toggleLift(lifted);
    else if (landing) {
      landing = undefined;
      renderSheet();
    } else setTool('selecionar');
    return;
  }
  if (typing(event.target)) return;
  if (event.key === ' ') {
    spaceDown = true;
    viewport.classList.add('space');
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    if (event.key === '0') {
      event.preventDefault();
      zoomAt(1 / view.zoom);
    }
    return;
  }
  if (event.key === '+' || event.key === '=') zoomAt(1.2);
  else if (event.key === '-') zoomAt(1 / 1.2);
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNote)
    deleteNote(selectedNote);
  else {
    const id = KEYS[event.key.toLowerCase()];
    if (id) {
      event.preventDefault();
      runTool(id);
    }
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    spaceDown = false;
    viewport.classList.remove('space');
  }
});

window.addEventListener('resize', drawMinimap);
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu();
});

let hintTimer: ReturnType<typeof setTimeout> | undefined;
function showHint(text: string, sticky = false): void {
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  if (tool === 'selecionar' && !sticky) hintTimer = setTimeout(hideHint, 2500);
}
function hideHint(): void {
  hint.hidden = true;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showError(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 6000);
}

// ---- Mensagens da extensão ----------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToMesa>) => {
  const message = event.data;
  if (transcritor.receber(message)) return;
  switch (message.type) {
    case 'vozStatus':
      vozStatus = message.status;
      for (const botao of cardLayer.querySelectorAll<HTMLButtonElement>('.voz-mic')) {
        microfones.get(botao)?.definirStatus(vozStatus);
      }
      return;
    case 'init':
      layout = message.layout;
      cards = { ...layout.cards };
      notes = [...layout.notes];
      portals = [...layout.portals];
      links = [...layout.links];
      view = { ...layout.view };
      hasFolder = message.hasFolder;
      profiles = message.profiles;
      for (const node of cardLayer.querySelectorAll('.note, .portal')) node.remove();
      applyView();
      render();
      return;
    case 'profiles':
      profiles = message.profiles;
      render();
      return;
    case 'sessions': {
      const first = !loaded;
      sessions = message.sessions;
      roles = message.roles;
      loaded = true;
      render();
      renderSheet();
      if (first && Object.keys(layout.cards).length === 0 && sessions.length > 0) fitAll();
      return;
    }
    case 'externas':
      external = { ativo: message.ativo, sessoes: message.sessoes };
      renderExternal();
      return;
    case 'transcript': {
      transcripts.set(message.sessionId, [...message.items]);
      refreshCard(message.sessionId);
      return;
    }
    case 'patch': {
      const items = transcripts.get(message.sessionId) ?? [];
      items[message.index] = message.item;
      transcripts.set(message.sessionId, items);
      scheduleCard(message.sessionId);
      return;
    }
    case 'changes':
      changes.set(message.sessionId, message.files ?? []);
      renderSidebar();
      renderZones();
      refreshCard(message.sessionId);
      renderSheet();
      return;
    case 'started': {
      const at = message.at;
      if (at) {
        const rect = cards[message.sessionId] ?? { x: 0, y: 0, w: CARD_W, h: CARD_H };
        cards = { ...cards, [message.sessionId]: { ...rect, x: snap(at.x), y: snap(at.y) } };
      }
      startEnded();
      // A lista de sessões pode chegar depois desta mensagem.
      if (!cards[message.sessionId]) focusWhenPlaced = message.sessionId;
      render();
      focusSession(message.sessionId);
      save();
      return;
    }
    case 'usage':
      usage = message.summary;
      renderSidebar();
      renderUsage();
      return;
    case 'files':
      fileWaiters.get(message.requestId)?.(message.files);
      fileWaiters.delete(message.requestId);
      return;
    case 'focus':
      focusSession(message.sessionId);
      return;
    case 'error':
      startEnded();
      showError(message.text);
      return;
    case 'offline':
      showError(l10n.t('FaKL Core is not responding. The Desk comes back when it reconnects.'));
      return;
  }
});

/** Desde quando cada sessão está ocupada; o modelo pode levar um minuto. */
const busySince = new Map<string, number>();

/** " 32 s" enquanto o agente pensa ou executa, para não parecer travado. */
function elapsed(session: AgentSessionInfo): string {
  if (toneOf(session.state) !== 'busy') {
    busySince.delete(session.sessionId);
    return '';
  }
  const since = busySince.get(session.sessionId) ?? Date.now();
  busySince.set(session.sessionId, since);
  const seconds = Math.floor((Date.now() - since) / 1000);
  return seconds >= 3 ? ` ${seconds} s` : '';
}

// Só a linha de estado; refazer o cartão inteiro atrapalharia quem digita nele.
setInterval(() => {
  for (const sessionId of busySince.keys()) {
    const session = sessions.find((s) => s.sessionId === sessionId);
    const sub = cardNodes.get(sessionId)?.querySelector<HTMLElement>('.sub');
    if (!session || !sub) continue;
    const where = session.worktree ? session.worktree.branch : l10n.t('open folder');
    sub.textContent = `${agentStateLabel(session.state)}${elapsed(session)} · ${where}`;
  }
}, 1000);

function refreshCard(sessionId: string): void {
  const node = cardNodes.get(sessionId);
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (node && session) updateCard(node, session);
}

// Muitas partes de texto por segundo: redesenha cada cartão no máximo por quadro.
const dirty = new Set<string>();
let frame = 0;
function scheduleCard(sessionId: string): void {
  dirty.add(sessionId);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const id of dirty) refreshCard(id);
    dirty.clear();
  });
}

setTool('selecionar');
applyView();
post({ type: 'ready' });
initCoach(vscode, 'mesa');
