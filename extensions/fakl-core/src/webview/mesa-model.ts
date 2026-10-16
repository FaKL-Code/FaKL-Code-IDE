/**
 * Regras da Mesa (ADR 0017) sem DOM, para o webview e os testes: grade,
 * posições, arrumação em árvore, andares, cabos e quem pede atenção.
 */
import { l10n } from '@fakl/i18n';
import type { AgentSessionInfo, AgentState } from '@fakl/protocol';

export { initials, usageRing, type UsageRing } from '@fakl/conversa';

/** Passo da grade: cartões e notas encaixam nele. */
export const GRID = 20;
export const CARD_W = 360;
export const CARD_H = 300;
export const NOTE_W = 240;
export const NOTE_H = 160;
const GAP_X = 60;
const GAP_Y = 100;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MesaNote extends Rect {
  readonly id: string;
  readonly text: string;
}

/** Cabo que o usuário puxou entre dois cartões (nota ou agente). */
export interface MesaLink {
  readonly from: string;
  readonly to: string;
}

export interface MesaView {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** O que a Mesa guarda por pasta aberta. */
/** Prévia de um endereço (o app rodando em localhost) aberta na mesa. */
export interface MesaPortal extends Rect {
  readonly id: string;
  readonly url: string;
}

export interface MesaLayout {
  readonly cards: Readonly<Record<string, Rect>>;
  readonly notes: readonly MesaNote[];
  readonly portals: readonly MesaPortal[];
  readonly links: readonly MesaLink[];
  readonly view: MesaView;
}

/** Papel de uma sessão numa execução do maestro. */
export interface MesaRole {
  readonly sessionId: string;
  readonly papel: string;
  readonly parentSessionId?: string;
  readonly tarefa?: string;
}

export const EMPTY_LAYOUT: MesaLayout = {
  cards: {},
  notes: [],
  portals: [],
  links: [],
  view: { x: 0, y: 0, zoom: 1 },
};

export const PORTAL_W = 640;
export const PORTAL_H = 420;

/** Só http(s); o resto (file:, javascript:) não abre numa prévia. */
export function portalUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  // `localhost:5173` é host e porta, não um esquema.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Lê um layout salvo, descartando o que não tem a forma esperada. */
export function parseLayout(raw: unknown): MesaLayout {
  if (!raw || typeof raw !== 'object') return EMPTY_LAYOUT;
  const value = raw as Partial<Record<keyof MesaLayout, unknown>>;
  const isRect = (r: unknown): r is Rect =>
    !!r &&
    typeof r === 'object' &&
    ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]));
  const cards: Record<string, Rect> = {};
  if (value.cards && typeof value.cards === 'object') {
    for (const [id, rect] of Object.entries(value.cards)) if (isRect(rect)) cards[id] = rect;
  }
  const notes = Array.isArray(value.notes)
    ? value.notes.filter(
        (n): n is MesaNote =>
          isRect(n) &&
          typeof (n as MesaNote).id === 'string' &&
          typeof (n as MesaNote).text === 'string',
      )
    : [];
  const links = Array.isArray(value.links)
    ? value.links.filter(
        (l): l is MesaLink =>
          !!l && typeof (l as MesaLink).from === 'string' && typeof (l as MesaLink).to === 'string',
      )
    : [];
  const portals = Array.isArray(value.portals)
    ? value.portals.filter(
        (p): p is MesaPortal =>
          isRect(p) &&
          typeof (p as MesaPortal).id === 'string' &&
          typeof (p as MesaPortal).url === 'string' &&
          portalUrl((p as MesaPortal).url) !== undefined,
      )
    : [];
  const view = value.view as Partial<MesaView> | undefined;
  return {
    cards,
    notes,
    portals,
    links,
    view:
      view && Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.zoom)
        ? { x: view.x ?? 0, y: view.y ?? 0, zoom: clampZoom(view.zoom ?? 1) }
        : EMPTY_LAYOUT.view,
  };
}

/** Cor de destaque de cada provedor, igual no cartão, no cabo e no andar. */
export function accentFor(provedor: string | undefined): string {
  switch ((provedor ?? '').toLowerCase()) {
    case 'anthropic':
      return '#fbbf24';
    case 'openai':
      return '#34d399';
    case 'google':
      return '#a78bfa';
    case 'ollama':
    case 'lmstudio':
    case 'local':
      return '#f472b6';
    default:
      return '#22d3ee';
  }
}

/** Cor do selo do papel; papéis que o maestro inventar ganham uma cor estável. */
export function roleColor(papel: string): string {
  const fixed: Record<string, string> = {
    maestro: '#fbbf24',
    executor: '#22d3ee',
    revisor: '#a78bfa',
    testes: '#34d399',
  };
  const known = fixed[papel];
  if (known) return known;
  const palette = ['#60a5fa', '#f472b6', '#fb923c', '#4ade80', '#c084fc'];
  let hash = 0;
  for (const char of papel) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? '#60a5fa';
}

export type Tone = 'idle' | 'busy' | 'attention' | 'paused' | 'done' | 'failed';

export function toneOf(state: AgentState): Tone {
  switch (state) {
    case 'pensando':
    case 'executando':
    case 'preparando':
      return 'busy';
    case 'aguardando-permissão':
    case 'aguardando-você':
      return 'attention';
    case 'pausado':
      return 'paused';
    case 'concluído':
    case 'parado':
      return 'done';
    case 'falhou':
      return 'failed';
    case 'ocioso':
      return 'idle';
  }
}

/**
 * Sessões que esperam você, na ordem em que a navegação por atenção passa:
 * pedidos de permissão primeiro, depois perguntas, depois falhas.
 */
export function attentionQueue(sessions: readonly AgentSessionInfo[]): string[] {
  const rank = (state: AgentState): number =>
    state === 'aguardando-permissão' ? 0 : state === 'aguardando-você' ? 1 : 2;
  return sessions
    .filter((s) => toneOf(s.state) === 'attention' || s.state === 'falhou')
    .sort((a, b) => rank(a.state) - rank(b.state) || a.sessionId.localeCompare(b.sessionId))
    .map((s) => s.sessionId);
}

export type FloorState = 'trabalhando' | 'bloqueado' | 'revisar' | 'livre' | 'concluído';

export interface Floor {
  /** Branch do worktree, ou a pasta para quem trabalha direto nela. */
  readonly key: string;
  readonly nome: string;
  readonly worktree: boolean;
  readonly sessions: readonly string[];
  readonly state: FloorState;
  readonly arquivos: number;
}

/**
 * Andares: um por worktree (ou pela pasta aberta), com o estado que diz se
 * dá para pousar o trabalho. `changed` tem quantos arquivos cada sessão mudou.
 */
export function floorsOf(
  sessions: readonly AgentSessionInfo[],
  changed: ReadonlyMap<string, number>,
): Floor[] {
  const groups = new Map<string, AgentSessionInfo[]>();
  for (const session of sessions) {
    const key = session.worktree?.branch ?? session.cwd;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return [...groups].map(([key, members]) => {
    const tones = members.map((s) => toneOf(s.state));
    const arquivos = members.reduce((sum, s) => sum + (changed.get(s.sessionId) ?? 0), 0);
    const state: FloorState = tones.some((t) => t === 'attention' || t === 'failed')
      ? 'bloqueado'
      : tones.some((t) => t === 'busy')
        ? 'trabalhando'
        : arquivos > 0
          ? 'revisar'
          : tones.every((t) => t === 'done')
            ? 'concluído'
            : // Agente parado à espera de mensagem, sem nada mudado.
              'livre';
    const worktree = members.some((s) => s.worktree);
    const avulso = /^fakl\/avulso\/(.+)$/.exec(key);
    // Agente avulso: o branch é só o id da sessão, que não diz nada a ninguém.
    const nome = avulso
      ? `${members[0]?.nome ?? l10n.t('agent')} · ${(avulso[1] ?? '').slice(-4).toLowerCase()}`
      : worktree
        ? key.replace(/^fakl\//, '')
        : (key.split(/[\\/]/).pop() ?? key);
    return { key, nome, worktree, sessions: members.map((s) => s.sessionId), state, arquivos };
  });
}

/** Retângulo que contém todos, para enquadrar e para o minimapa. */
export function bounds(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Visão que mostra `area` inteira num viewport de `width` × `height`. */
export function fitView(area: Rect, width: number, height: number, margin = 60): MesaView {
  const zoom = clampZoom(
    Math.min(1, (width - margin * 2) / area.w, (height - margin * 2) / area.h),
  );
  return {
    zoom,
    x: width / 2 - (area.x + area.w / 2) * zoom,
    y: height / 2 - (area.y + area.h / 2) * zoom,
  };
}

/**
 * Arruma em árvore: cada maestro em cima, os subagentes numa fileira embaixo
 * (o Maestro Mode do Maestri). Sessões sem pai viram raízes lado a lado.
 */
export function tidy(ids: readonly string[], roles: readonly MesaRole[]): Record<string, Rect> {
  const parent = new Map<string, string>();
  const present = new Set(ids);
  for (const role of roles) {
    if (role.parentSessionId && present.has(role.parentSessionId) && present.has(role.sessionId)) {
      parent.set(role.sessionId, role.parentSessionId);
    }
  }
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const p = parent.get(id);
    if (p) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const width = (id: string): number => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return CARD_W;
    const sum = kids.reduce((total, kid) => total + width(kid), 0) + GAP_X * (kids.length - 1);
    return Math.max(CARD_W, sum);
  };
  const out: Record<string, Rect> = {};
  const place = (id: string, left: number, top: number): void => {
    const span = width(id);
    out[id] = { x: snap(left + (span - CARD_W) / 2), y: snap(top), w: CARD_W, h: CARD_H };
    let cursor = left;
    for (const kid of children.get(id) ?? []) {
      place(kid, cursor, top + CARD_H + GAP_Y);
      cursor += width(kid) + GAP_X;
    }
  };
  let left = 0;
  for (const id of ids.filter((i) => !parent.has(i))) {
    place(id, left, 0);
    left += width(id) + GAP_X * 2;
  }
  return out;
}

/**
 * Lugar de um cartão novo: abaixo do pai, ao lado dos irmãos; sem pai, à
 * direita de tudo o que já está na mesa.
 */
export function placeNew(
  id: string,
  cards: Readonly<Record<string, Rect>>,
  roles: readonly MesaRole[],
  others: readonly Rect[] = [],
): Rect {
  const role = roles.find((r) => r.sessionId === id);
  const parentRect = role?.parentSessionId ? cards[role.parentSessionId] : undefined;
  if (parentRect && role?.parentSessionId) {
    const siblings = roles
      .filter((r) => r.parentSessionId === role.parentSessionId && r.sessionId !== id)
      .flatMap((r) => cards[r.sessionId] ?? []);
    const y = parentRect.y + parentRect.h + GAP_Y;
    const x =
      siblings.length > 0 ? Math.max(...siblings.map((s) => s.x + s.w)) + GAP_X : parentRect.x;
    return { x: snap(x), y: snap(y), w: CARD_W, h: CARD_H };
  }
  const all = bounds([...Object.values(cards), ...others]);
  if (!all) return { x: 0, y: 0, w: CARD_W, h: CARD_H };
  return { x: snap(all.x + all.w + GAP_X), y: snap(all.y), w: CARD_W, h: CARD_H };
}

/**
 * Caminho SVG de um cabo entre dois cartões: sai da base de um e entra no
 * topo do outro (ou pelas laterais, se estão lado a lado), com a barriga de
 * uma corda pendurada.
 */
export function ropePath(a: Rect, b: Rect): string {
  const aBelow = b.y >= a.y + a.h;
  const bBelow = a.y >= b.y + b.h;
  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  if (aBelow || bBelow) {
    const [top, bottom] = aBelow ? [a, b] : [b, a];
    x1 = top.x + top.w / 2;
    y1 = top.y + top.h;
    x2 = bottom.x + bottom.w / 2;
    y2 = bottom.y;
    const sag = Math.max(40, Math.abs(y2 - y1) * 0.5 + Math.abs(x2 - x1) * 0.15);
    return `M${x1},${y1} C${x1},${y1 + sag} ${x2},${y2 - sag} ${x2},${y2}`;
  }
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  x1 = left.x + left.w;
  y1 = left.y + left.h / 2;
  x2 = right.x;
  y2 = right.y + right.h / 2;
  const sag = Math.max(30, Math.abs(x2 - x1) * 0.25);
  const mid = Math.max(y1, y2) + sag;
  return `M${x1},${y1} C${x1 + sag},${mid} ${x2 - sag},${mid} ${x2},${y2}`;
}

/** Palavra que está sendo digitada antes do cursor, quando começa com @ ou #. */
export function mentionAt(
  text: string,
  caret: number,
): { readonly kind: '@' | '#'; readonly query: string; readonly start: number } | undefined {
  const match = /(^|\s)([@#])([^\s@#]*)$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  const kind = match[2] as '@' | '#';
  const query = match[3] ?? '';
  return { kind, query, start: caret - query.length - 1 };
}

const MENTION_LIMIT = 4000;

/**
 * Troca cada @Nome de outro agente pela última resposta dele, anexada ao fim
 * da mensagem, para um agente ler o que o outro disse sem copiar e colar.
 */
export function expandMentions(text: string, answers: ReadonlyMap<string, string>): string {
  const blocks: string[] = [];
  const names = [...answers.keys()].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name) || !text.includes(`@${name}`)) continue;
    seen.add(name);
    const answer = answers.get(name)?.trim();
    if (!answer) continue;
    const cut =
      answer.length > MENTION_LIMIT
        ? `${answer.slice(0, MENTION_LIMIT)}\n${l10n.t('[…truncated]')}`
        : answer;
    blocks.push(`${l10n.t('Last reply from {0}:', name)}\n${cut}`);
  }
  return blocks.length > 0 ? `${text}\n\n---\n${blocks.join('\n\n---\n')}` : text;
}
