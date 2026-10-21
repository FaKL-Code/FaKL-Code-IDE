import { currentLocale, l10n, useLocale } from '@fakl/i18n';
import type {
  AgentChangedFile,
  AgentOptionInfo,
  AgentProfileAvailability,
  AgentSessionInfo,
  AgentState,
  CostSummary,
  PermissionPolicyName,
} from '@fakl/protocol';

import type { FromChat, ToChat } from '../chat-protocol.js';
import { recoveryTime } from '../recovery-ui.js';
import { renderMarkdown, type ChatItem } from '@fakl/conversa';
import {
  agentStateLabel,
  baseName,
  changeStatusLabel,
  composeMessage,
  dirName,
  fileKind,
  formatCost,
  findNewSession,
  formatTokens,
  logoKey,
  optionKind,
  optionValueLabel,
  pendingOptionChanges,
  PROVIDER_NAMES,
  preview,
  providerColor,
  relativeTime,
  rememberOptions,
  sortOptions,
  sumUsage,
  toolIconName,
  toolRunning,
  toolStatusLabel,
  usageBreakdown,
  withChoices,
  type ContextChip,
  type OptionChoices,
} from './chat-model.js';
import {
  avatar,
  closeFloating,
  el,
  floatingAnchor,
  flashCopied,
  iconButton,
  installTooltips,
  openFloating,
  openMenu,
  type MenuHandle,
  type MenuItem,
} from './chat-ui.js';
import { initCoach } from './coach.js';
import { fileIcon, icon, providerLogo, type IconName } from './icons.js';
import { initials, mentionAt, toneOf, usageRing } from './mesa-model.js';
import { criarMicrofone, criarTranscritor, ehAtalhoDeVoz } from './voz-mic.js';

interface VsCodeApi {
  postMessage(message: FromChat): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>; vem antes de qualquer texto na tela.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();
const BUSY = new Set(['preparando', 'pensando', 'executando', 'aguardando-permissão']);
const FINAL = new Set(['concluído', 'falhou', 'parado']);

interface Saved {
  profileId?: string;
  worktree?: boolean;
  /** A próxima conversa é simples, sem ferramentas. */
  conversa?: boolean;
  /** Modo escolhido para conversas novas; ausente, vale o do perfil ou do config.yaml. */
  mode?: PermissionPolicyName;
  draft?: string;
  /** Últimas opções vistas de cada perfil (modelo, raciocínio...), para oferecê-las antes da conversa existir. */
  known?: Record<string, readonly AgentOptionInfo[]>;
  /** Escolhas do usuário para a próxima conversa, por perfil. */
  choices?: Record<string, OptionChoices>;
}

interface ModeInfo {
  readonly value: PermissionPolicyName;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
}

/** Modos de permissão; função para o texto sair no idioma escolhido em `useLocale`. */
function modes(): readonly ModeInfo[] {
  return [
    {
      value: 'perguntar',
      label: l10n.t('Ask'),
      description: l10n.t('The agent asks permission for each action'),
      icon: 'shield',
    },
    {
      value: 'aprovar-leitura',
      label: l10n.t('Approve reads'),
      description: l10n.t('Reads and searches go straight through; everything else asks'),
      icon: 'eye',
    },
    {
      value: 'aprovar-tudo',
      label: l10n.t('Approve all'),
      description: l10n.t("The agent doesn't ask permission"),
      icon: 'check',
    },
    {
      value: 'autopilot',
      label: l10n.t('Autopilot'),
      description: l10n.t(
        "Approves everything without asking; the work stays on the agent's branch, and your folder doesn't change",
      ),
      icon: 'lightning',
    },
  ];
}

type Place = 'worktree' | 'folder' | 'conversa';

interface PlaceInfo {
  readonly id: Place;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
}

function places(): readonly [PlaceInfo, ...PlaceInfo[]] {
  return [
    {
      id: 'worktree',
      label: l10n.t('Worktree'),
      description: l10n.t("Its own branch; your files don't change"),
      icon: 'branch',
    },
    {
      id: 'folder',
      label: l10n.t('Current folder'),
      description: l10n.t('Changes go straight to your files'),
      icon: 'folder',
    },
    {
      id: 'conversa',
      label: l10n.t('Conversation'),
      description: l10n.t("Only answers: no tools, doesn't see your project, costs less"),
      icon: 'message',
    },
  ];
}

function suggestions(): readonly { icon: IconName; title: string; prompt: string }[] {
  return [
    {
      icon: 'search',
      title: l10n.t('Explain this project'),
      prompt: l10n.t('Explain the structure of this project and where to start reading the code.'),
    },
    {
      icon: 'wrench',
      title: l10n.t('Fix failing tests'),
      prompt: l10n.t('Run the tests, find what is failing, and fix it.'),
    },
    {
      icon: 'diff',
      title: l10n.t('Review what changed'),
      prompt: l10n.t('Review the pending git changes and point out problems.'),
    },
    {
      icon: 'code',
      title: l10n.t('Write tests'),
      prompt: l10n.t('Write tests for the most important parts without coverage.'),
    },
  ];
}

const saved = (vscode.getState() ?? {}) as Saved;

let profiles: readonly AgentProfileAvailability[] = [];
let hasFolder = true;
let sessions: readonly AgentSessionInfo[] = [];
let selected: string | undefined;
let items: ChatItem[] = [];
/** O histórico da conversa aberta já chegou (senão mostra o esqueleto). */
let loaded = true;
let sending = false;
let changes: readonly AgentChangedFile[] = [];
let usage: CostSummary | undefined;
let chosenProfile = saved.profileId ?? '';
let chosenPlace: Place = saved.conversa
  ? 'conversa'
  : saved.worktree === false
    ? 'folder'
    : 'worktree';
let chosenMode: PermissionPolicyName | '' = saved.mode ?? '';
let knownOptions: Record<string, readonly AgentOptionInfo[]> = saved.known ?? {};
const choices: Record<string, OptionChoices> = saved.choices ?? {};
/** Conversa recém-pedida: quando ela abrir, as escolhas feitas antes dela são aplicadas. */
let pendingApply:
  { profileId: string; before: Set<string>; choices: OptionChoices; until: number } | undefined;
const chips: ContextChip[] = [];
/** Quando cada item apareceu (só dos que chegaram ao vivo). */
const times = new Map<number, number>();
/** Cartões abertos pelo usuário, por posição na conversa aberta. */
const opened = new Set<string>();

const app = document.getElementById('app') ?? document.body;
installTooltips();

// --- Cabeçalho --------------------------------------------------------------

const header = el('header', { class: 'header' });
const sessionButton = el('button', {
  type: 'button',
  class: 'session-btn',
  'aria-haspopup': 'listbox',
  'aria-expanded': 'false',
  'aria-label': l10n.t('Conversations'),
});
const dot = el('span', { class: 'dot idle', 'aria-hidden': 'true' });
const sessionName = el('span', { class: 'session-name' }, l10n.t('New conversation'));
sessionButton.append(dot, sessionName, icon('chevronDown', 14));
const headerActions = el('div', { class: 'header-actions' });
const pauseButton = iconButton('pause', l10n.t('Pause'));
const usageButton = el('button', {
  type: 'button',
  class: 'icon-btn usage-btn',
  'aria-haspopup': 'dialog',
  'aria-expanded': 'false',
  'aria-label': l10n.t('Usage and context'),
});
usageButton.dataset.tip = l10n.t('Usage and context');
const usageText = el('span', { class: 'usage-text' });
usageButton.append(icon('gauge', 16), usageText);
const newButton = iconButton('plus', l10n.t('New conversation'));
const moreButton = iconButton('more', l10n.t('More actions'));
moreButton.setAttribute('aria-haspopup', 'listbox');
moreButton.setAttribute('aria-expanded', 'false');
headerActions.append(pauseButton, usageButton, newButton, moreButton);
header.append(sessionButton, headerActions);

// --- Mensagens ---------------------------------------------------------------

const stage = el('main', { class: 'stage' });
const messages = el('div', {
  class: 'messages',
  role: 'log',
  'aria-label': l10n.t('Conversation'),
});
messages.hidden = true;
const list = el('div', { class: 'list' });
const live = el('div', { class: 'live', hidden: '' });
messages.append(list, live);
const skeleton = el('div', { class: 'skeleton', 'aria-hidden': 'true', hidden: '' });
for (const width of ['38%', '92%', '78%', '54%', '86%']) {
  const bar = el('div', { class: 'skeleton-line' });
  bar.style.width = width;
  skeleton.append(bar);
}
const welcome = el('div', { class: 'welcome' });
const jump = iconButton('arrowDown', l10n.t('Jump to end'), 'jump');
jump.hidden = true;
stage.append(messages, skeleton, welcome, jump);

const banner = el('div', { class: 'banner', hidden: '', role: 'status' });
const errorLine = el('div', { class: 'error', role: 'alert', hidden: '' });

// --- Arquivos alterados --------------------------------------------------------

const changesPanel = el('details', { class: 'changes', hidden: '' });
changesPanel.open = true;
const changesSummary = el('summary');
const changesActions = el('div', { class: 'changes-actions' });
const applyAll = el('button', { type: 'button', class: 'btn primary small' }, l10n.t('Apply all'));
const rejectAll = el('button', { type: 'button', class: 'btn small' }, l10n.t('Reject all'));
changesActions.append(applyAll, rejectAll);
const changesList = el('ul', { class: 'changes-list' });
changesPanel.append(changesSummary, changesActions, changesList);

// --- Composer ---------------------------------------------------------------------

const composer = el('form', { class: 'composer' });
const field = el('div', { class: 'field' });
const chipsBox = el('div', { class: 'chips', hidden: '' });
const input = el('textarea', {
  rows: '1',
  placeholder: l10n.t('Ask for a task or ask a question. @ agents and files, # contexts'),
  'aria-label': l10n.t('Message to the agent'),
  'aria-autocomplete': 'list',
  spellcheck: 'true',
});
input.value = saved.draft ?? '';
const bar = el('div', { class: 'bar' });
const barLeft = el('div', { class: 'bar-left' });
const barRight = el('div', { class: 'bar-right' });
const attachButton = iconButton('paperclip', l10n.t('Attach context (#)'));
const agentPill = pill('sparkle', l10n.t('Agent'), l10n.t('Agent'));
const placePill = pill('branch', l10n.t('Worktree'), l10n.t('Where the agent works'));
const modePill = pill('shield', l10n.t('Mode'), l10n.t('Permission mode'));
const optionsBox = el('span', { class: 'session-options' });
const sendButton = el('button', {
  type: 'submit',
  class: 'send',
  'aria-label': l10n.t('Send'),
});
sendButton.dataset.tip = l10n.t('Send (Enter)');
// Microfone: dita no campo; você revisa e envia como sempre.
const transcritor = criarTranscritor(post);
const mic = criarMicrofone({
  campo: input,
  classe: 'icon-btn voz-mic',
  transcrever: (audio) => transcritor.transcrever(audio),
  onErro: (text) => {
    errorLine.replaceChildren(icon('alert', 14), el('span', {}, text));
    errorLine.hidden = false;
  },
  onConfigurar: () => {
    post({ type: 'vozConfigurar' });
  },
  onEstado: (estado) => {
    if (estado === 'ouvindo') errorLine.hidden = true;
  },
});
const micSlot = el('span', { class: 'mic-slot' });
micSlot.append(mic.botao);
barLeft.append(attachButton, agentPill.button, placePill.button);
/** Linha própria, sempre visível: modo de permissão, modelo, raciocínio, fast e o que mais o agente oferecer. */
const optionsBar = el('div', {
  class: 'options-bar',
  role: 'group',
  'aria-label': l10n.t('Agent options'),
});
optionsBar.append(modePill.button, optionsBox);
barRight.append(micSlot, sendButton);
bar.append(barLeft, barRight);
field.append(chipsBox, input, bar, optionsBar);
composer.append(field);

app.append(header, stage, changesPanel, banner, errorLine, composer);

/** Botão em forma de pílula: ícone, rótulo e seta; o rótulo some em barra estreita. */
function pill(
  name: IconName,
  label: string,
  title: string,
  description?: string,
): { button: HTMLButtonElement; set(text: string): void; setIcon(next: IconName): void } {
  const button = el('button', {
    type: 'button',
    class: 'pill',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  });
  const text = el('span', { class: 'pill-label' });
  const set = (value: string): void => {
    text.textContent = value;
    // Em barra estreita o rótulo some; o nome acessível e o tooltip dizem o valor.
    button.setAttribute('aria-label', `${title}: ${value}`);
    button.dataset.tip = description ?? `${title}: ${value}`;
  };
  set(label);
  const lead = el('span', { class: 'pill-icon' });
  lead.append(icon(name, 14));
  button.append(lead, text, icon('chevronDown', 12));
  return {
    button,
    set,
    setIcon(next): void {
      lead.replaceChildren(icon(next, 14));
    },
  };
}

function persist(): void {
  const state: Saved = {
    worktree: chosenPlace === 'worktree',
    conversa: chosenPlace === 'conversa',
    draft: input.value,
    ...(chosenMode ? { mode: chosenMode } : {}),
    ...(chosenProfile ? { profileId: chosenProfile } : {}),
    known: knownOptions,
    choices,
  };
  vscode.setState(state);
}

function current(): AgentSessionInfo | undefined {
  return selected ? sessions.find((s) => s.sessionId === selected) : undefined;
}

function readyProfiles(): AgentProfileAvailability[] {
  return profiles.filter((p) => p.availability.status === 'pronto');
}

function profileOf(session: AgentSessionInfo | undefined): AgentProfileAvailability | undefined {
  return session ? profiles.find((p) => p.id === session.profileId) : undefined;
}

function agentAvatar(session: AgentSessionInfo | undefined, size = 24): HTMLElement {
  const profile = profileOf(session);
  return avatar(
    initials(session?.nome ?? 'FaKL'),
    providerColor(profile?.provedor ?? session?.provedor),
    size,
    logoKey(profile?.provedor ?? session?.provedor, true),
  );
}

function profileAvatar(profile: AgentProfileAvailability, size = 20): HTMLElement {
  return avatar(
    initials(profile.nome),
    providerColor(profile.provedor),
    size,
    logoKey(profile.provedor, true),
  );
}

function post(message: FromChat): void {
  vscode.postMessage(message);
}

// --- Cabeçalho: renderização -----------------------------------------------------------

function renderHeader(): void {
  const session = current();
  sessionName.textContent = session ? session.nome : l10n.t('New conversation');
  dot.className = `dot ${session ? toneOf(session.state) : 'idle'}`;
  dot.dataset.tip = session ? agentStateLabel(session.state) : '';
  const where = session?.conversa
    ? l10n.t('Conversation (no tools)')
    : session?.worktree
      ? l10n.t('Branch {0}', session.worktree.branch)
      : session?.cwd;
  sessionButton.dataset.tip = session
    ? `${agentStateLabel(session.state)}${where ? ` · ${where}` : ''}`
    : l10n.t('Conversations');

  const ended = session !== undefined && FINAL.has(session.state);
  const paused = session?.state === 'pausado' || !!session?.retomada;
  pauseButton.hidden = !session || (ended && !session.retomada);
  pauseButton.replaceChildren(icon(paused ? 'play' : 'pause', 16));
  const pauseLabel = paused ? l10n.t('Resume') : l10n.t('Pause');
  pauseButton.setAttribute('aria-label', pauseLabel);
  pauseButton.dataset.tip = pauseLabel;

  const tokens = session ? usageBreakdown(session.usage).total : 0;
  usageText.textContent = tokens > 0 ? formatTokens(tokens) : '';
}

function openSessionMenu(): void {
  if (floatingAnchor() === sessionButton) {
    closeFloating(true);
    return;
  }
  const entries: MenuItem[] = [
    {
      id: '',
      label: l10n.t('New conversation'),
      icon: 'plus',
      group: l10n.t('Start'),
      keywords: 'novo nova',
    },
    ...sessions.map((s) => {
      const cost = formatCost(s.usage.cost);
      return {
        id: s.sessionId,
        label: s.nome,
        description: [s.retomada ? l10n.t('Session limit') : agentStateLabel(s.state), cost]
          .filter(Boolean)
          .join(' · '),
        group: l10n.t('Conversations'),
        icon: () => {
          const wrap = el('span', { class: 'menu-avatar' });
          wrap.append(agentAvatar(s, 20));
          wrap.append(el('span', { class: `dot ${toneOf(s.state)}` }));
          return wrap;
        },
        checked: s.sessionId === selected,
      } satisfies MenuItem;
    }),
  ];
  openMenu(sessionButton, entries, {
    label: l10n.t('Conversations'),
    searchable: sessions.length > 5,
    placeholder: l10n.t('Search conversations'),
    width: 320,
    onPick(item) {
      errorLine.hidden = true;
      post(item.id ? { type: 'select', sessionId: item.id } : { type: 'select' });
      if (!item.id) input.focus();
    },
  });
}

function openMoreMenu(): void {
  if (floatingAnchor() === moreButton) {
    closeFloating(true);
    return;
  }
  const session = current();
  const ended = session !== undefined && FINAL.has(session.state);
  const paused = session?.state === 'pausado' || !!session?.retomada;
  const entries: MenuItem[] = [];
  if (session && (!ended || session.retomada)) {
    entries.push({
      id: 'pause',
      label: paused ? l10n.t('Resume the agent') : l10n.t('Pause the agent'),
      icon: paused ? 'play' : 'pause',
    });
  }
  entries.push({ id: 'mesa', label: l10n.t('Open on the Desk'), icon: 'globe' });
  if (session) entries.push({ id: 'copy', label: l10n.t('Copy conversation'), icon: 'copy' });
  if (session && !ended) {
    entries.push({
      id: 'stop',
      label: l10n.t('Stop the agent'),
      icon: 'stop',
      danger: true,
      separatorBefore: true,
    });
  }
  openMenu(moreButton, entries, {
    label: l10n.t('More actions'),
    width: 230,
    align: 'end',
    onPick(item) {
      if (item.id === 'pause') togglePause();
      else if (item.id === 'mesa')
        post(session ? { type: 'openMesa', sessionId: session.sessionId } : { type: 'openMesa' });
      else if (item.id === 'copy') void copyText(transcriptText());
      else if (item.id === 'stop' && session) post({ type: 'stop', sessionId: session.sessionId });
    },
  });
}

function togglePause(): void {
  const session = current();
  if (session) {
    post({
      type: session.state === 'pausado' || session.retomada ? 'resume' : 'pause',
      sessionId: session.sessionId,
    });
  }
}

function transcriptText(): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case 'user':
          return `${l10n.t('You')}:\n${item.text}`;
        case 'agent':
          return `${current()?.nome ?? l10n.t('Agent')}:\n${item.text}`;
        case 'tool':
          return l10n.t('[tool] {0}', item.title);
        case 'permission':
          return `${l10n.t('[permission] {0}', item.title)}${item.detail ? `\n${item.detail}` : ''}`;
        case 'notice':
          return `[${item.tone}] ${item.text}`;
        case 'thought':
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Sem permissão de área de transferência: o botão não mostra o check.
    return false;
  }
}

// --- Anéis de uso ----------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 2 * Math.PI * 15;

/** Anel SVG de 0 a 1; sem fração, um anel tracejado de "sem teto". */
function ring(fraction: number | undefined, color: string, size = 44): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
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
  arc.style.stroke = color;
  const value = fraction ?? 1;
  arc.style.strokeDasharray = `${String(RING * value)} ${String(RING)}`;
  if (fraction === undefined) arc.style.opacity = '0.3';
  svg.append(track, arc);
  return svg;
}

function ringStat(
  fraction: number | undefined,
  color: string,
  title: string,
  value: string,
): HTMLElement {
  const box = el('div', { class: 'ring-stat' });
  const wrap = el('div', { class: 'ring-wrap' });
  wrap.append(ring(fraction, color));
  if (fraction !== undefined) {
    wrap.append(el('span', { class: 'ring-pct' }, `${String(Math.round(fraction * 100))}%`));
  }
  box.append(
    wrap,
    el('span', { class: 'ring-title' }, title),
    el('span', { class: 'ring-value' }, value),
  );
  return box;
}

function openUsage(): void {
  if (floatingAnchor() === usageButton) {
    closeFloating(true);
    return;
  }
  const panel = el('div', {
    class: 'popover usage',
    role: 'dialog',
    'aria-label': l10n.t('Usage and context'),
  });
  panel.tabIndex = -1;
  const session = current();
  if (session) {
    const b = usageBreakdown(session.usage);
    panel.append(el('div', { class: 'panel-title' }, l10n.t('This conversation')));
    const rings = el('div', { class: 'rings' });
    rings.append(
      ringStat(
        b.total > 0 ? b.inputShare : undefined,
        'var(--vscode-charts-blue)',
        l10n.t('Input'),
        `${formatTokens(b.input)} tok`,
      ),
      ringStat(
        b.total > 0 ? b.outputShare : undefined,
        'var(--vscode-charts-green)',
        l10n.t('Output'),
        `${formatTokens(b.output)} tok`,
      ),
    );
    panel.append(rings);
    const rows = el('dl', { class: 'kv' });
    rows.append(el('dt', {}, l10n.t('Total')), el('dd', {}, `${formatTokens(b.total)} tokens`));
    const cost = formatCost(session.usage.cost);
    rows.append(el('dt', {}, l10n.t('Cost')), el('dd', {}, cost || l10n.t('no cost reported')));
    rows.append(el('dt', {}, l10n.t('Mode')), el('dd', {}, modeLabel(session.permissoes)));
    if (session.contaClaude) {
      rows.append(el('dt', {}, l10n.t('Account')), el('dd', {}, session.contaClaude.apelido));
    }
    panel.append(rows);
  }
  const all = sumUsage(sessions);
  panel.append(
    el('div', { class: 'panel-title' }, l10n.t('All conversations ({0})', sessions.length)),
  );
  const rows = el('dl', { class: 'kv' });
  rows.append(
    el('dt', {}, l10n.t('Tokens')),
    el('dd', {}, formatTokens(usageBreakdown(all).total)),
  );
  const allCost = formatCost(all.cost);
  if (allCost) rows.append(el('dt', {}, l10n.t('Cost')), el('dd', {}, allCost));
  panel.append(rows);

  const entries = usage ? Object.entries(usage.porProvedor) : [];
  if (usage && entries.length > 0) {
    panel.append(el('div', { class: 'panel-title' }, l10n.t('Today, by provider')));
    const providers = el('ul', { class: 'providers' });
    for (const [provedor, totals] of entries) {
      const r = usageRing(
        provedor,
        totals,
        usage.tetos[provedor],
        usage.bloqueados.includes(provedor),
      );
      const li = el('li', { class: `provider${r.bloqueado ? ' blocked' : ''}` });
      const wrap = el('div', { class: 'ring-wrap small' });
      wrap.append(
        ring(r.fracao, r.bloqueado ? 'var(--vscode-errorForeground)' : providerColor(provedor), 32),
      );
      const logo = logoKey(provedor);
      if (logo) {
        const center = el('span', { class: 'ring-logo', 'aria-hidden': 'true' });
        center.append(providerLogo(logo, 14));
        wrap.append(center);
      }
      const text = el('div', { class: 'provider-text' });
      text.append(
        el('span', { class: 'provider-name' }, PROVIDER_NAMES[provedor] ?? provedor),
        el(
          'span',
          { class: 'provider-value' },
          r.bloqueado
            ? l10n.t('at the cap · {0}', r.gasto)
            : r.teto
              ? l10n.t('{0} of {1}', r.gasto, r.teto)
              : l10n.t('{0} · no cap', r.gasto),
        ),
      );
      li.append(wrap, text);
      if (r.fracao !== undefined) {
        li.append(el('span', { class: 'provider-pct' }, `${String(Math.round(r.fracao * 100))}%`));
      }
      providers.append(li);
    }
    panel.append(providers);
  }
  openFloating(usageButton, panel, { width: 300, align: 'end' });
  panel.focus();
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeFloating(true);
    }
  });
}

function modeLabel(mode: PermissionPolicyName): string {
  return modes().find((m) => m.value === mode)?.label ?? mode;
}

// --- Boas-vindas ---------------------------------------------------------------------------------

function renderWelcome(): void {
  welcome.replaceChildren();
  const empty = !selected;
  welcome.hidden = !empty;
  if (!empty) return;
  const hero = el('div', { class: 'hero' });
  const logo = el('div', { class: 'hero-logo', 'aria-hidden': 'true' });
  logo.append(icon('sparkle', 26));
  hero.append(logo, el('h2', {}, l10n.t('FaKL Agents')));
  const ready = readyProfiles();
  hero.append(
    el(
      'p',
      {},
      !hasFolder
        ? l10n.t('Open a folder for an agent to work in.')
        : ready.length > 0
          ? l10n.t(
              'Choose the agent and where it works, then send the first message. Each conversation becomes an agent on the Desk.',
            )
          : l10n.t('No agents installed yet.'),
    ),
  );
  welcome.append(hero);
  if (hasFolder && ready.length > 0) {
    const grid = el('div', { class: 'suggestions', role: 'list' });
    for (const suggestion of suggestions()) {
      const card = el('button', { type: 'button', class: 'suggestion', role: 'listitem' });
      const lead = el('span', { class: 'suggestion-icon' });
      lead.append(icon(suggestion.icon, 16));
      card.append(lead, el('span', {}, suggestion.title));
      card.addEventListener('click', () => {
        input.value = suggestion.prompt;
        autosize();
        persist();
        renderComposer();
        input.focus();
      });
      grid.append(card);
    }
    welcome.append(grid);
  }
  const missing = profiles.filter((p) => p.availability.status !== 'pronto');
  if (missing.length > 0) {
    const box = el('div', { class: 'install' });
    box.append(el('div', { class: 'panel-title' }, l10n.t('Agents to install')));
    for (const profile of missing) {
      const row = el('div', { class: 'install-row' });
      row.append(profileAvatar(profile, 22), el('span', { class: 'install-name' }, profile.nome));
      if (profile.availability.install) {
        const button = el('button', { type: 'button', class: 'btn small' }, l10n.t('Install'));
        button.setAttribute('aria-label', l10n.t('Install {0}', profile.nome));
        button.addEventListener('click', () => {
          post({ type: 'install', profileId: profile.id });
        });
        row.append(button);
      } else {
        // Modelo local com o servidor fechado: não há o que instalar daqui.
        row.append(
          el('span', { class: 'muted' }, l10n.t('open the local server (Ollama or LM Studio)')),
        );
      }
      box.append(row);
    }
    welcome.append(box);
  }
}

// --- Composer: renderização ---------------------------------------------------------------------

function optionIcon(option: AgentOptionInfo): IconName {
  switch (optionKind(option)) {
    case 'model':
      return 'model';
    case 'effort':
      return 'bulb';
    case 'fast':
      return 'lightning';
    case 'mode':
      return 'shield';
    default:
      return 'config';
  }
}

/** Troca uma opção: na conversa aberta vai ao agente; antes dela, fica guardada para quando abrir. */
function chooseOption(
  session: AgentSessionInfo | undefined,
  option: AgentOptionInfo,
  value: string | boolean,
): void {
  if (session) {
    post({ type: 'setOption', sessionId: session.sessionId, id: option.id, value });
    return;
  }
  choices[chosenProfile] = { ...choices[chosenProfile], [option.id]: value };
  persist();
  renderComposer();
  input.focus();
}

/** Uma pílula por opção que o agente oferece (modelo, raciocínio, fast...); sempre visíveis. */
function renderOptions(session: AgentSessionInfo | undefined, ended: boolean): void {
  optionsBox.replaceChildren();
  if (ended) return;
  const options = session
    ? session.opcoes
    : withChoices(knownOptions[chosenProfile] ?? [], choices[chosenProfile] ?? {});
  if (options.length === 0) {
    const hint = el('span', { class: 'pill hint' });
    hint.dataset.tip = session
      ? l10n.t("This agent doesn't offer a model or reasoning to switch")
      : l10n.t(
          'Model, reasoning, and other options show up here after the first conversation with this agent',
        );
    hint.append(
      el(
        'span',
        { class: 'pill-label' },
        session ? l10n.t('No other options') : l10n.t('Model and reasoning'),
      ),
    );
    if (!session) optionsBox.append(hint);
    return;
  }
  for (const option of sortOptions(options)) {
    if (option.valores) {
      const values = option.valores;
      const p = pill(optionIcon(option), optionValueLabel(option), option.nome, option.descricao);
      p.button.addEventListener('click', () => {
        if (floatingAnchor() === p.button) {
          closeFloating(true);
          return;
        }
        openMenu(
          p.button,
          values.map(
            (value) =>
              ({
                id: value.id,
                label: value.nome,
                ...(value.descricao ? { description: value.descricao } : {}),
                group: option.nome,
                checked: value.id === String(option.atual),
              }) satisfies MenuItem,
          ),
          {
            label: option.nome,
            searchable: values.length > 7,
            placeholder: l10n.t('Search {0}', option.nome.toLowerCase()),
            placement: 'up',
            width: 300,
            onPick(item) {
              chooseOption(session, option, item.id);
            },
          },
        );
      });
      optionsBox.append(p.button);
    } else {
      const toggle = el('button', {
        type: 'button',
        class: 'pill toggle',
        'aria-pressed': String(option.atual === true),
        'aria-label': option.nome,
      });
      toggle.dataset.tip = option.descricao ?? option.nome;
      const lead = el('span', { class: 'pill-icon' });
      lead.append(icon(optionIcon(option), 14));
      toggle.append(lead, el('span', { class: 'pill-label' }, option.nome));
      toggle.addEventListener('click', () => {
        chooseOption(session, option, option.atual !== true);
      });
      optionsBox.append(toggle);
    }
  }
}

function renderComposer(): void {
  const session = current();
  const isNew = !session;
  const busy = session !== undefined && BUSY.has(session.state);
  const paused = session?.state === 'pausado';
  const ended = session !== undefined && FINAL.has(session.state);
  // Encerrada mas guardada: uma mensagem nova retoma a sessão (ADR 0022).
  const resumable = ended && session.retomavel === true;

  const ready = readyProfiles();
  if (!ready.some((p) => p.id === chosenProfile)) chosenProfile = ready[0]?.id ?? '';
  const profile = ready.find((p) => p.id === chosenProfile);
  agentPill.button.hidden = !isNew;
  agentPill.set(profile?.nome ?? l10n.t('No agent'));
  placePill.button.hidden = !isNew;
  const placeList = places();
  const place = placeList.find((p) => p.id === chosenPlace) ?? placeList[0];
  placePill.set(place.label);
  placePill.setIcon(place.icon);

  modePill.button.hidden = ended && !resumable;
  const mode = session ? session.permissoes : chosenMode;
  const modeInfo = modes().find((m) => m.value === mode);
  modePill.set(modeInfo?.label ?? l10n.t('Default mode'));
  modePill.setIcon(modeInfo?.icon ?? 'shield');

  renderOptions(session, ended && !resumable);

  const canType = isNew ? hasFolder && chosenProfile !== '' : !ended || resumable;
  input.disabled = !canType;
  attachButton.disabled = !canType;
  micSlot.hidden = !canType;
  if (!canType) mic.cancelar();
  const hasContent = input.value.trim() !== '' || chips.length > 0;
  const showStop = busy && !hasContent;
  sendButton.classList.toggle('stop', showStop);
  sendButton.type = showStop ? 'button' : 'submit';
  sendButton.disabled = showStop ? false : !canType || sending || !hasContent;
  const label = showStop
    ? l10n.t('Pause the agent')
    : busy || paused
      ? l10n.t('Queue')
      : l10n.t('Send');
  sendButton.setAttribute('aria-label', label);
  sendButton.dataset.tip = showStop
    ? l10n.t('Pause the agent (Esc)')
    : busy || paused
      ? l10n.t('Queue (Enter)')
      : l10n.t('Send (Enter)');
  sendButton.replaceChildren(icon(showStop ? 'stop' : 'send', 16));

  input.placeholder = resumable
    ? l10n.t('Send a message to resume this conversation')
    : ended
      ? l10n.t('This conversation has ended')
      : isNew
        ? l10n.t('Ask for a task or ask a question. @ agents and files, # contexts')
        : l10n.t('Send another message. @ agents and files, # contexts');

  banner.replaceChildren();
  banner.classList.toggle('recovery', !!session?.retomada);
  banner.hidden = !paused && !ended && !session?.retomada;
  if (session?.retomada) {
    const { retomada } = session;
    const details = el('div', { class: 'recovery-details' });
    details.append(el('div', {}, retomada.mensagem));
    const time = recoveryTime(retomada.retomarEm);
    if (time) {
      details.append(
        el(
          'div',
          {},
          retomada.automatica
            ? l10n.t('Next attempt: {0}', time)
            : l10n.t('Resume available: {0}', time),
        ),
      );
    }
    const resume = el('button', { type: 'button', class: 'btn small' }, l10n.t('Resume now'));
    resume.addEventListener('click', () => {
      post({ type: 'resume', sessionId: session.sessionId });
    });
    const label = el('label', { class: 'recovery-auto' });
    const automatic = el('input', { type: 'checkbox' });
    automatic.checked = retomada.automatica;
    automatic.addEventListener('change', () => {
      automatic.disabled = true;
      post({
        type: 'setAutoResume',
        sessionId: session.sessionId,
        automatica: automatic.checked,
      });
    });
    label.append(automatic, el('span', {}, l10n.t('Resume automatically when the limit resets')));
    banner.append(icon('pause', 14), details, resume, label);
  } else if (paused) {
    banner.append(
      icon('pause', 14),
      el('span', {}, l10n.t('Agent paused. New messages wait until you resume.')),
    );
    const resume = el('button', { type: 'button', class: 'btn small' }, l10n.t('Resume'));
    resume.addEventListener('click', togglePause);
    banner.append(resume);
  } else if (session && ended) {
    banner.append(icon('alert', 14), el('span', {}, endedNotice(session.state, resumable)));
    const fresh = el(
      'button',
      { type: 'button', class: 'btn small primary' },
      l10n.t('New conversation'),
    );
    fresh.addEventListener('click', () => {
      post({ type: 'select' });
    });
    banner.append(fresh);
  }
  renderChips();
}

/** Aviso da conversa encerrada, uma frase inteira por estado final. */
function endedNotice(state: AgentState, resumable: boolean): string {
  switch (state) {
    case 'falhou':
      return resumable
        ? l10n.t(
            'Agent failed. Send a message to pick up where it left off, or open a new conversation.',
          )
        : l10n.t('Agent failed. Open a new conversation to continue.');
    case 'parado':
      return resumable
        ? l10n.t(
            'Agent stopped. Send a message to pick up where it left off, or open a new conversation.',
          )
        : l10n.t('Agent stopped. Open a new conversation to continue.');
    default:
      // Só os estados finais chegam aqui; 'concluído' é o que sobra.
      return resumable
        ? l10n.t(
            'Agent finished. Send a message to pick up where it left off, or open a new conversation.',
          )
        : l10n.t('Agent finished. Open a new conversation to continue.');
  }
}

function renderChips(): void {
  chipsBox.hidden = chips.length === 0;
  chipsBox.replaceChildren(
    ...chips.map((chip, index) => {
      const node = el('span', { class: `chip ${chip.kind}` });
      node.dataset.tip = chip.insert;
      if (chip.kind === 'file') node.append(fileIcon(fileKind(chip.label), 13));
      else node.append(icon(chip.kind === 'agent' ? 'at' : 'hash', 13));
      node.append(el('span', { class: 'chip-label' }, chip.label));
      const remove = el('button', {
        type: 'button',
        class: 'chip-x',
        'aria-label': l10n.t('Remove {0}', chip.label),
      });
      remove.append(icon('x', 11));
      remove.addEventListener('click', () => {
        chips.splice(index, 1);
        renderComposer();
        input.focus();
      });
      node.append(remove);
      return node;
    }),
  );
}

function render(): void {
  renderHeader();
  renderWelcome();
  renderComposer();
  renderStage();
}

function renderStage(): void {
  const session = current();
  skeleton.hidden = !selected || loaded;
  messages.hidden = !selected || !loaded;
  messages.setAttribute('aria-busy', String(session !== undefined && BUSY.has(session.state)));
  renderLive();
}

// --- Menus do composer ------------------------------------------------------------------------------

agentPill.button.addEventListener('click', () => {
  if (floatingAnchor() === agentPill.button) {
    closeFloating(true);
    return;
  }
  openMenu(
    agentPill.button,
    readyProfiles().map(
      (p) =>
        ({
          id: p.id,
          label: p.nome,
          description: PROVIDER_NAMES[p.provedor] ?? p.provedor,
          group: l10n.t('Agents'),
          icon: () => profileAvatar(p, 20),
          checked: p.id === chosenProfile,
        }) satisfies MenuItem,
    ),
    {
      label: l10n.t('Agent'),
      searchable: readyProfiles().length > 7,
      placeholder: l10n.t('Search agents'),
      placement: 'up',
      onPick(item) {
        chosenProfile = item.id;
        persist();
        renderComposer();
        input.focus();
      },
    },
  );
});

placePill.button.addEventListener('click', () => {
  if (floatingAnchor() === placePill.button) {
    closeFloating(true);
    return;
  }
  openMenu(
    placePill.button,
    places().map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      icon: p.icon,
      checked: p.id === chosenPlace,
    })),
    {
      label: l10n.t('Where the agent works'),
      placement: 'up',
      onPick(item) {
        chosenPlace =
          item.id === 'folder' ? 'folder' : item.id === 'conversa' ? 'conversa' : 'worktree';
        persist();
        renderComposer();
        input.focus();
      },
    },
  );
});

modePill.button.addEventListener('click', () => {
  if (floatingAnchor() === modePill.button) {
    closeFloating(true);
    return;
  }
  const session = current();
  const active = session ? session.permissoes : chosenMode;
  const entries: MenuItem[] = [
    ...(session
      ? []
      : [
          {
            id: '',
            label: l10n.t('Default mode'),
            description: l10n.t('From the profile or config.yaml'),
            icon: 'shield' as const,
            checked: active === '',
          },
        ]),
    ...modes().map((m) => ({
      id: m.value,
      label: m.label,
      description: m.description,
      icon: m.icon,
      checked: m.value === active,
    })),
  ];
  openMenu(modePill.button, entries, {
    label: l10n.t('Permission mode'),
    placement: 'up',
    width: 300,
    onPick(item) {
      const mode = item.id as PermissionPolicyName | '';
      if (session && mode) {
        post({ type: 'setPermissions', sessionId: session.sessionId, permissions: mode });
        return;
      }
      chosenMode = mode;
      persist();
      renderComposer();
      input.focus();
    },
  });
});

sessionButton.addEventListener('click', openSessionMenu);
moreButton.addEventListener('click', openMoreMenu);
usageButton.addEventListener('click', openUsage);

// --- Menções: @ agentes e arquivos, # contextos ------------------------------------------------------------

let fileSeq = 0;
const fileWaiters = new Map<
  number,
  (reply: { files: readonly string[]; active?: string }) => void
>();

function requestFiles(query: string): Promise<{ files: readonly string[]; active?: string }> {
  const requestId = ++fileSeq;
  post({ type: 'findFiles', requestId, query });
  return new Promise((resolve) => {
    fileWaiters.set(requestId, resolve);
    setTimeout(() => {
      if (fileWaiters.delete(requestId)) resolve({ files: [] });
    }, 3000);
  });
}

interface MentionItem extends MenuItem {
  readonly chip: ContextChip;
}

let mentionMenu: MenuHandle<MentionItem> | undefined;
let mentionStart = 0;
let mentionToken = 0;
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

function closeMention(): void {
  mentionMenu?.close();
  mentionMenu = undefined;
  input.removeAttribute('aria-controls');
  input.removeAttribute('aria-activedescendant');
}

function fileItem(path: string, prefix: '#' | '@'): MentionItem {
  const dir = dirName(path);
  return {
    id: `file:${path}`,
    label: baseName(path),
    ...(dir ? { description: dir } : {}),
    group: l10n.t('Files'),
    keywords: path,
    icon: () => fileIcon(fileKind(path), 15),
    chip: {
      kind: 'file',
      label: baseName(path),
      insert: `${prefix === '@' ? '#' : prefix}${path}`,
    },
  };
}

function agentItems(query: string): MentionItem[] {
  const q = query.toLowerCase();
  return sessions
    .filter((s) => s.sessionId !== selected && s.nome.toLowerCase().includes(q))
    .map((s) => ({
      id: `agent:${s.sessionId}`,
      label: s.nome,
      description: l10n.t('{0} · their last reply goes along', agentStateLabel(s.state)),
      group: l10n.t('Agents'),
      icon: () => agentAvatar(s, 20),
      chip: { kind: 'agent' as const, label: s.nome, insert: `@${s.nome}` },
    }));
}

function contextItems(query: string, active: string | undefined): MentionItem[] {
  const q = query.toLowerCase();
  const out: MentionItem[] = [];
  if (active) {
    out.push({
      id: 'ctx:active',
      label: l10n.t('Current file'),
      description: active,
      group: l10n.t('Contexts'),
      icon: () => fileIcon(fileKind(active), 15),
      chip: { kind: 'context', label: baseName(active), insert: `#${active}` },
    });
  }
  const pendingPaths = changes
    .filter((f) => f.resolution !== 'aplicado' && f.resolution !== 'rejeitado')
    .map((f) => f.path);
  if (pendingPaths.length > 0) {
    out.push({
      id: 'ctx:changes',
      label: l10n.t('Pending changes'),
      description:
        pendingPaths.length === 1
          ? l10n.t('1 file from the agent')
          : l10n.t('{0} files from the agent', pendingPaths.length),
      group: l10n.t('Contexts'),
      icon: 'diff',
      chip: {
        kind: 'context',
        label: l10n.t('Pending changes'),
        insert: l10n.t('(changed files: {0})', pendingPaths.join(', ')),
      },
    });
  }
  return out.filter((item) => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(q));
}

function updateMention(): void {
  const found = input.disabled ? undefined : mentionAt(input.value, input.selectionStart);
  if (!found) {
    closeMention();
    return;
  }
  mentionStart = found.start;
  const token = ++mentionToken;
  const local = found.kind === '@' ? agentItems(found.query) : [];
  const open = (entries: MentionItem[]): void => {
    if (!mentionMenu) {
      mentionMenu = openMenu(field, entries, {
        label: found.kind === '@' ? l10n.t('Agents and files') : l10n.t('Contexts and files'),
        placement: 'up',
        width: Math.max(260, field.getBoundingClientRect().width),
        external: true,
        prefiltered: true,
        empty: l10n.t('No results'),
        onPick: acceptMention,
        onClose() {
          mentionMenu = undefined;
        },
      });
      input.setAttribute('aria-controls', mentionMenu.listId);
    } else {
      mentionMenu.setItems(entries);
    }
    const id = mentionMenu.activeId();
    if (id) input.setAttribute('aria-activedescendant', id);
  };
  if (local.length > 0) open(local);
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(
    () => {
      void requestFiles(found.query).then((reply) => {
        if (token !== mentionToken) return;
        const contexts = found.kind === '#' ? contextItems(found.query, reply.active) : [];
        const files = reply.files.map((file) => fileItem(file, found.kind));
        open([...(found.kind === '@' ? agentItems(found.query) : []), ...contexts, ...files]);
      });
    },
    found.query ? 120 : 0,
  );
}

function acceptMention(item: MentionItem): void {
  const caret = input.selectionStart;
  // O token digitado (@abc ou #abc) sai do texto; vira um chip acima do campo.
  const before = input.value.slice(0, mentionStart).replace(/[ \t]+$/, '');
  const after = input.value.slice(caret).replace(/^[ \t]+/, '');
  input.value = before && after ? `${before} ${after}` : `${before}${after}`;
  const next = before.length + (before && after ? 1 : 0);
  input.setSelectionRange(next, next);
  if (!chips.some((chip) => chip.insert === item.chip.insert)) chips.push(item.chip);
  closeMention();
  autosize();
  persist();
  renderComposer();
  input.focus();
}

// --- Mensagens ----------------------------------------------------------------------------------------------

function itemKey(index: number): string {
  return `${selected ?? ''}:${String(index)}`;
}

function copyButton(getText: () => string, label = l10n.t('Copy')): HTMLButtonElement {
  const button = iconButton('copy', label, 'icon-btn small copy');
  button.replaceChildren(icon('copy', 14));
  button.addEventListener('click', () => {
    void copyText(getText()).then((ok) => {
      if (ok) flashCopied(button, 'copy');
    });
  });
  return button;
}

/** Cada bloco de código ganha cabeçalho com a linguagem e o botão de copiar. */
function decorateCode(root: HTMLElement): void {
  for (const pre of root.querySelectorAll('pre')) {
    const wrapper = el('div', { class: 'code' });
    const head = el('div', { class: 'code-head' });
    head.append(el('span', { class: 'code-lang' }, pre.dataset.lang ?? l10n.t('text')));
    head.append(copyButton(() => pre.textContent, l10n.t('Copy code')));
    pre.replaceWith(wrapper);
    wrapper.append(head, pre);
  }
}

function stamp(index: number): HTMLElement | undefined {
  const at = times.get(index);
  if (at === undefined) return undefined;
  const node = el('time', { class: 'time' }, relativeTime(at, Date.now()));
  node.dataset.ts = String(at);
  node.dataset.tip = new Date(at).toLocaleString(currentLocale() === 'pt-br' ? 'pt-BR' : 'en-US');
  return node;
}

function isStreaming(index: number): boolean {
  const session = current();
  return session !== undefined && BUSY.has(session.state) && index === items.length - 1;
}

/** O cabeçalho com avatar e nome aparece na primeira fala do agente depois de uma do usuário, mesmo com ferramentas no meio. */
function startsAgentTurn(index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const kind = items[i]?.kind;
    if (kind === 'agent') return false;
    if (kind === 'user' || kind === 'notice') return true;
  }
  return true;
}

function renderItem(item: ChatItem, index: number): HTMLElement {
  switch (item.kind) {
    case 'user': {
      const node = el('div', { class: 'msg user' });
      const bubble = el('div', { class: 'bubble' }, item.text);
      const actions = el('div', { class: 'msg-actions' });
      const time = stamp(index);
      if (time) actions.append(time);
      actions.append(copyButton(() => item.text, l10n.t('Copy message')));
      node.append(bubble, actions);
      return node;
    }
    case 'agent': {
      const node = el('div', {
        class: `msg agent${isStreaming(index) ? ' streaming' : ''}`,
      });
      if (startsAgentTurn(index)) {
        const session = current();
        const head = el('div', { class: 'msg-head' });
        head.append(
          agentAvatar(session),
          el('span', { class: 'msg-name' }, session?.nome ?? l10n.t('Agent')),
        );
        const time = stamp(index);
        if (time) head.append(time);
        node.append(head);
      }
      const body = el('div', { class: 'md' });
      body.innerHTML = renderMarkdown(item.text, { highlight: true });
      decorateCode(body);
      node.append(body);
      const actions = el('div', { class: 'msg-actions' });
      actions.append(copyButton(() => item.text, l10n.t('Copy reply')));
      node.append(actions);
      return node;
    }
    case 'thought': {
      const thinking = isStreaming(index);
      const node = el('details', { class: `thought${thinking ? ' thinking' : ''}` });
      const key = itemKey(index);
      node.open = opened.has(key);
      node.addEventListener('toggle', () => {
        if (node.open) opened.add(key);
        else opened.delete(key);
      });
      const summary = el('summary');
      const lead = el('span', { class: 'row-icon' });
      lead.append(icon('bulb', 14));
      summary.append(lead);
      if (thinking) {
        summary.append(el('span', { class: 'thinking-label' }, l10n.t('Thinking')));
        summary.append(el('span', { class: 'dots', 'aria-hidden': 'true' }, ''));
      } else {
        summary.append(el('span', { class: 'row-title' }, l10n.t('Reasoning')));
        summary.append(el('span', { class: 'row-preview' }, preview(item.text)));
      }
      summary.append(icon('chevronRight', 12));
      node.append(summary, el('div', { class: 'thought-body' }, item.text));
      return node;
    }
    case 'tool': {
      const running = toolRunning(item.status);
      const failed = item.status === 'failed';
      const node = el('details', {
        class: `tool-card ${running ? 'running' : failed ? 'failed' : 'done'}`,
      });
      const key = itemKey(index);
      node.open = opened.has(key);
      node.addEventListener('toggle', () => {
        if (node.open) opened.add(key);
        else opened.delete(key);
      });
      const summary = el('summary');
      const state = el('span', { class: 'tool-state' });
      state.append(icon(running ? 'spinner' : failed ? 'alert' : 'check', 14));
      state.dataset.tip = toolStatusLabel(item.status);
      const kind = el('span', { class: 'row-icon' });
      kind.append(icon(toolIconName(item.toolKind), 14));
      summary.append(
        state,
        kind,
        el('span', { class: 'row-title' }, item.title),
        icon('chevronRight', 12),
      );
      const body = el('dl', { class: 'tool-body kv' });
      body.append(el('dt', {}, l10n.t('Status')), el('dd', {}, toolStatusLabel(item.status)));
      if (item.toolKind) body.append(el('dt', {}, l10n.t('Kind')), el('dd', {}, item.toolKind));
      body.append(el('dt', {}, l10n.t('Call')), el('dd', { class: 'mono' }, item.id));
      node.append(summary, body);
      return node;
    }
    case 'permission': {
      const node = el('div', {
        class: `permission${item.answer ? ` answered ${item.answer}` : ''}`,
        role: 'group',
      });
      const head = el('div', { class: 'permission-head' });
      const lead = el('span', { class: 'row-icon' });
      lead.append(icon('shield', 16));
      head.append(
        lead,
        el('span', { class: 'permission-title' }, l10n.t('Asks for permission: {0}', item.title)),
      );
      node.append(head);
      // Os argumentos da chamada (o comando do ssh_exec, o caminho do arquivo): decidir sem eles é no escuro.
      if (item.detail) node.append(el('pre', { class: 'permission-detail' }, item.detail));
      if (item.answer) {
        const badge = el('div', { class: 'permission-answer' });
        badge.append(icon(item.answer === 'permitido' ? 'check' : 'x', 13));
        badge.append(item.answer === 'permitido' ? l10n.t('Allowed') : l10n.t('Denied'));
        node.append(badge);
      } else {
        const actions = el('div', { class: 'permission-actions' });
        const allow = el('button', { type: 'button', class: 'btn primary small' }, l10n.t('Allow'));
        const deny = el('button', { type: 'button', class: 'btn small' }, l10n.t('Deny'));
        const answer = (value: boolean): void => {
          if (!selected) return;
          allow.disabled = true;
          deny.disabled = true;
          post({ type: 'permission', sessionId: selected, id: item.id, allow: value });
        };
        allow.addEventListener('click', () => {
          answer(true);
        });
        deny.addEventListener('click', () => {
          answer(false);
        });
        actions.append(allow, deny);
        node.append(actions);
      }
      return node;
    }
    case 'notice': {
      const node = el('div', {
        class: `notice ${item.tone}`,
        ...(item.tone === 'error' ? { role: 'alert' } : {}),
      });
      node.append(icon(item.tone === 'error' ? 'alert' : 'circle', 13), el('span', {}, item.text));
      return node;
    }
  }
}

function nearBottom(): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function scrollToEnd(smooth = false): void {
  messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

/** O agente ainda não respondeu: mostra quem está trabalhando e em quê. */
function renderLive(): void {
  const session = current();
  const last = items[items.length - 1];
  const waiting =
    session !== undefined &&
    BUSY.has(session.state) &&
    (last === undefined || last.kind === 'user' || last.kind === 'notice');
  live.hidden = !waiting;
  live.replaceChildren();
  if (!waiting) return;
  live.append(agentAvatar(session, 22));
  const label =
    session.state === 'preparando'
      ? l10n.t('Preparing the agent')
      : session.state === 'executando'
        ? l10n.t('Working')
        : l10n.t('Thinking');
  live.append(
    el('span', { class: 'thinking-label' }, label),
    el('span', { class: 'dots', 'aria-hidden': 'true' }, ''),
  );
}

function renderMessages(): void {
  list.replaceChildren(...items.map(renderItem));
  if (items.length === 0 && selected && loaded) {
    const empty = el('div', { class: 'empty-chat' });
    empty.append(
      icon('message', 22),
      el('span', {}, l10n.t('Empty conversation. Send the first message below.')),
    );
    list.append(empty);
  }
  renderStage();
  scrollToEnd();
  jump.hidden = true;
}

function patch(index: number, item: ChatItem): void {
  const stick = nearBottom();
  if (index >= items.length) times.set(index, Date.now());
  items[index] = item;
  list.querySelector('.empty-chat')?.remove();
  const node = renderItem(item, index);
  const existing = list.children[index];
  if (existing) existing.replaceWith(node);
  else list.append(node);
  // O item anterior deixa de "transmitir" quando chega outro depois dele.
  const before = items[index - 1];
  if (before && index > 0 && index === items.length - 1) {
    const prev = list.children[index - 1];
    if (prev && (before.kind === 'agent' || before.kind === 'thought')) {
      prev.replaceWith(renderItem(before, index - 1));
    }
  }
  renderLive();
  if (stick) scrollToEnd();
  else jump.hidden = false;
}

messages.addEventListener('scroll', () => {
  jump.hidden = nearBottom();
});
jump.addEventListener('click', () => {
  scrollToEnd(true);
  jump.hidden = true;
});

// --- Arquivos alterados ------------------------------------------------------------------------------------------------

const STATUS_LETTER: Record<AgentChangedFile['status'], string> = {
  adicionado: 'A',
  modificado: 'M',
  removido: 'D',
};

function pending(): string[] {
  return changes
    .filter((f) => f.resolution !== 'aplicado' && f.resolution !== 'rejeitado')
    .map((f) => f.path);
}

function resolve(type: 'applyFiles' | 'rejectFiles', paths: readonly string[]): void {
  if (!selected || paths.length === 0) return;
  post({ type, sessionId: selected, paths });
}

/** Só os arquivos pendentes ficam na lista; o painel some quando não sobra nenhum. */
function renderChanges(): void {
  const open = pending();
  changesPanel.hidden = !selected || open.length === 0;
  if (changesPanel.hidden) return;
  const applied = changes.filter((f) => f.resolution === 'aplicado').length;
  const rejected = changes.filter((f) => f.resolution === 'rejeitado').length;
  changesSummary.replaceChildren(
    icon('chevronRight', 12),
    icon('diff', 15),
    el(
      'span',
      { class: 'changes-title' },
      [
        open.length === 1 ? l10n.t('1 file changed') : l10n.t('{0} files changed', open.length),
        applied ? (applied === 1 ? l10n.t('1 applied') : l10n.t('{0} applied', applied)) : '',
        rejected ? (rejected === 1 ? l10n.t('1 rejected') : l10n.t('{0} rejected', rejected)) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  applyAll.disabled = false;
  rejectAll.disabled = false;
  const openSet = new Set(open);
  changesList.replaceChildren(
    ...changes
      .filter((file) => openSet.has(file.path))
      .map((file) => {
        const row = el('li', { class: `change ${file.resolution ?? ''}` });
        row.append(fileIcon(fileKind(file.path), 15));
        const name = el('button', { type: 'button', class: 'change-path' });
        name.dataset.tip = l10n.t('View the diff of {0}', file.path);
        name.setAttribute('aria-label', l10n.t('View the diff of {0}', file.path));
        const dir = dirName(file.path);
        name.append(el('span', { class: 'change-name' }, baseName(file.path)));
        if (dir) name.append(el('span', { class: 'change-dir' }, dir));
        name.addEventListener('click', () => {
          if (selected) post({ type: 'openDiff', sessionId: selected, path: file.path });
        });
        row.append(name);
        if (file.additions !== undefined && file.deletions !== undefined) {
          const stat = el('span', { class: 'change-stat' });
          stat.append(
            el('span', { class: 'add' }, `+${String(file.additions)}`),
            el('span', { class: 'del' }, `−${String(file.deletions)}`),
          );
          row.append(stat);
        }
        const letter = el(
          'span',
          { class: `change-status ${file.status}` },
          STATUS_LETTER[file.status],
        );
        letter.dataset.tip = changeStatusLabel(file.status);
        row.append(letter);
        if (file.resolution === 'conflito') {
          row.append(el('span', { class: 'change-resolution conflict' }, l10n.t('conflict')));
        }
        const accept = iconButton('check', l10n.t('Apply to your folder'), 'icon-btn small accept');
        accept.setAttribute('aria-label', l10n.t('Apply {0}', file.path));
        const reject = iconButton('x', l10n.t('Reject'), 'icon-btn small reject');
        reject.setAttribute('aria-label', l10n.t('Reject {0}', file.path));
        accept.addEventListener('click', () => {
          resolve('applyFiles', [file.path]);
        });
        reject.addEventListener('click', () => {
          resolve('rejectFiles', [file.path]);
        });
        row.append(accept, reject);
        return row;
      }),
  );
}

applyAll.addEventListener('click', () => {
  resolve('applyFiles', pending());
});
rejectAll.addEventListener('click', () => {
  resolve('rejectFiles', pending());
});

// --- Mensagens da extensão ------------------------------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToChat>) => {
  const message = event.data;
  if (transcritor.receber(message)) return;
  switch (message.type) {
    case 'vozStatus':
      mic.definirStatus(message.status);
      break;
    case 'profiles':
      profiles = message.profiles;
      hasFolder = message.hasFolder;
      render();
      break;
    case 'sessions': {
      const changed = selected !== message.selected;
      sessions = message.sessions;
      selected = message.selected;
      knownOptions = rememberOptions(knownOptions, sessions);
      applyPendingOptions();
      if (changed) {
        changes = [];
        times.clear();
        opened.clear();
        chips.length = 0;
        closeFloating();
        renderChanges();
        // Conversa aberta: espera o histórico (esqueleto); conversa nova: nada a esperar.
        loaded = !selected;
        items = [];
        list.replaceChildren();
      }
      render();
      // Estado e custo mudam o tempo todo; refaz só o que depende deles.
      if (!changed) refreshStreaming();
      break;
    }
    case 'transcript':
      if (message.sessionId !== selected) break;
      items = [...message.items];
      loaded = true;
      renderMessages();
      break;
    case 'patch':
      if (message.sessionId === selected) patch(message.index, message.item);
      break;
    case 'changes':
      if (message.sessionId !== selected) break;
      changes = message.files ?? [];
      renderChanges();
      break;
    case 'usage':
      usage = message.summary;
      break;
    case 'files': {
      const waiter = fileWaiters.get(message.requestId);
      fileWaiters.delete(message.requestId);
      waiter?.(
        message.active === undefined
          ? { files: message.files }
          : { files: message.files, active: message.active },
      );
      break;
    }
    case 'error':
      errorLine.replaceChildren(icon('alert', 14), el('span', {}, message.text));
      errorLine.hidden = false;
      sending = false;
      renderComposer();
      break;
  }
});

/** Quando o estado muda, o último item para ou volta a "transmitir". */
function refreshStreaming(): void {
  const last = items.length - 1;
  const item = items[last];
  if (item && loaded && (item.kind === 'agent' || item.kind === 'thought')) {
    list.children[last]?.replaceWith(renderItem(item, last));
  }
}

// --- Envio e atalhos ------------------------------------------------------------------------------------------------

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${String(Math.min(input.scrollHeight, 220))}px`;
}

/** Quando a conversa pedida abre, manda ao agente o modelo e o raciocínio escolhidos antes dela. */
function applyPendingOptions(): void {
  if (!pendingApply) return;
  if (Date.now() > pendingApply.until) {
    pendingApply = undefined;
    return;
  }
  const fresh = findNewSession(pendingApply.before, sessions, pendingApply.profileId);
  if (!fresh || fresh.opcoes.length === 0) return;
  for (const change of pendingOptionChanges(fresh.opcoes, pendingApply.choices)) {
    post({ type: 'setOption', sessionId: fresh.sessionId, id: change.id, value: change.value });
  }
  pendingApply = undefined;
}

function send(): void {
  const text = composeMessage(chips, input.value);
  if (!text || sendButton.disabled || sendButton.type !== 'submit') return;
  errorLine.hidden = true;
  const session = current();
  const message: FromChat = session
    ? { type: 'send', text, sessionId: session.sessionId }
    : {
        type: 'send',
        text,
        profileId: chosenProfile,
        worktree: chosenPlace === 'worktree',
        ...(chosenPlace === 'conversa' ? { conversa: true } : {}),
        ...(chosenMode ? { permissions: chosenMode } : {}),
      };
  post(message);
  if (!session) {
    const wanted = choices[chosenProfile] ?? {};
    if (Object.keys(wanted).length > 0) {
      pendingApply = {
        profileId: chosenProfile,
        before: new Set(sessions.map((x) => x.sessionId)),
        choices: wanted,
        until: Date.now() + 60_000,
      };
    }
  }
  input.value = '';
  chips.length = 0;
  closeMention();
  autosize();
  persist();
  renderComposer();
  if (!session) {
    // O agente leva alguns segundos para subir; evita abrir dois.
    sending = true;
    renderComposer();
    setTimeout(() => {
      sending = false;
      renderComposer();
    }, 3000);
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});
sendButton.addEventListener('click', () => {
  if (sendButton.type === 'button') togglePauseFromStop();
});

function togglePauseFromStop(): void {
  const session = current();
  if (session && BUSY.has(session.state)) post({ type: 'pause', sessionId: session.sessionId });
}

document.addEventListener('keydown', (event) => {
  if (!ehAtalhoDeVoz(event) || micSlot.hidden) return;
  event.preventDefault();
  mic.alternar();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && mic.estado === 'ouvindo') {
    event.preventDefault();
    mic.cancelar();
    return;
  }
  if (mentionMenu?.handleKey(event)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  } else if (event.key === 'Escape' && !event.isComposing) {
    togglePauseFromStop();
  } else if (event.key === 'Backspace' && input.value === '' && chips.length > 0) {
    chips.pop();
    renderComposer();
  }
});
input.addEventListener('input', () => {
  autosize();
  persist();
  renderComposer();
  updateMention();
});
input.addEventListener('click', () => {
  updateMention();
});
input.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== input) closeMention();
  }, 120);
});
attachButton.addEventListener('click', () => {
  if (input.disabled) return;
  const caret = input.selectionStart;
  const lead = caret > 0 && !/\s/.test(input.value.charAt(caret - 1)) ? ' ' : '';
  input.setRangeText(`${lead}#`, caret, input.selectionEnd, 'end');
  input.focus();
  updateMention();
});
pauseButton.addEventListener('click', togglePause);
newButton.addEventListener('click', () => {
  errorLine.hidden = true;
  post({ type: 'select' });
  input.focus();
});
window.addEventListener('focus', () => {
  post({ type: 'refreshProfiles' });
});

// Os carimbos ("há 3 min") envelhecem sozinhos.
setInterval(() => {
  for (const node of messages.querySelectorAll<HTMLElement>('time[data-ts]')) {
    node.textContent = relativeTime(Number(node.dataset.ts), Date.now());
  }
}, 30_000);

autosize();
render();
post({ type: 'ready' });
initCoach(vscode, 'chat');
