import type {
  AgentState,
  AgentStateEventData,
  AgentThumbnailEventData,
  CafeAgent,
  CafeScore,
  CafeState,
  FaklEvent,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import { agentSprites } from './art/agents.js';
import { C, KEY } from './art/palette.js';
import { sceneSprites, WALL_H } from './art/scene.js';
import { uiSprites } from './art/ui.js';
import { context, mix, newCanvas, shade, text } from './pixel.js';
import {
  draw,
  drawInHole,
  loadAssets,
  register,
  sheet,
  spriteDef,
  spritesVersion,
  tinted,
} from './sprites.js';

/*
 * Cyber café (SDD 13): sala isométrica 2:1 em pixel art, no estilo dos hotéis
 * virtuais. Tudo é sprite de `assets/` (ou o provisório de `art/`), montado
 * num quadro de 1x e ampliado sem suavizar. A sala só reflete os eventos do
 * Core; posição e animação dos avatares são o único estado local (ADR 0011).
 */

/** Onde a sala é desenhada e o que ela avisa a quem a hospeda. */
export interface CafeRoomOptions {
  readonly canvas: HTMLCanvasElement;
  /** Clicaram num avatar ou PC. */
  readonly onOpen: (sessionId: string) => void;
  /** Chegou evento de uma sessão que a sala não conhece; peça `cafe.state` de novo. */
  readonly onRefresh: () => void;
  /** Agentes, estados ou miniaturas mudaram; a faixa de telas se redesenha. */
  readonly onChange?: () => void;
  /**
   * Pasta com os PNGs de `packages/cafe/assets/` e, se houver, a lista dos
   * arquivos que existem nela. Sem isso, a sala usa os desenhos provisórios.
   */
  readonly assets?: { readonly base: string; readonly files?: readonly string[] };
  /** Quanto tempo ocioso antes de cochilar (padrão 90 s). A prévia encurta. */
  readonly sleepAfterMs?: number;
}

let options: CafeRoomOptions;

// --- Geometria -------------------------------------------------------------

const TW = 32;
const TH = 16;
const ROOM_W = 16;
const DESK_COLUMNS = [3, 5.2, 7.4, 9.6, 11.8];
const DESK_W = 1.6;
const DESK_D = 0.7;
const FIRST_DESK_ROW = 4;
const DESK_ROW_STEP = 3;
const TOP_AISLE = 3.2;
const LANE_X = 1.0;
const SPEED = 2.4; // ladrilhos por segundo
const FPS = 30;

interface Point {
  x: number;
  y: number;
}

let roomH = 13;
let originX = 0;
let originY = 0;

function iso(x: number, y: number, z = 0): Point {
  return { x: originX + ((x - y) * TW) / 2, y: originY + ((x + y) * TH) / 2 - z };
}

function deskRows(count: number): number {
  return Math.max(2, Math.ceil(count / DESK_COLUMNS.length));
}

/** Início da área da frente (sofá e sinuca), depois da última fileira. */
function front(): number {
  return FIRST_DESK_ROW + deskRows(slots.length) * DESK_ROW_STEP;
}

/** Canto de trás da mesa do PC `index`. */
function deskOf(index: number): Point {
  const column = DESK_COLUMNS[index % DESK_COLUMNS.length] ?? 3;
  return { x: column, y: FIRST_DESK_ROW + Math.floor(index / DESK_COLUMNS.length) * DESK_ROW_STEP };
}

/** Centro da cadeira, onde o agente senta de costas para quem vê. */
function chairOf(index: number): Point {
  const desk = deskOf(index);
  return { x: desk.x + DESK_W / 2, y: desk.y + 1.5 };
}

const door = (): Point => ({ x: 0.35, y: roomH - 1 });
const frontAisle = (): number => roomH - 1.2;

/** Corredores livres entre as fileiras de mesas. */
function aisles(): number[] {
  const rows = [TOP_AISLE];
  for (let r = 0; r < deskRows(slots.length); r++)
    rows.push(FIRST_DESK_ROW + r * DESK_ROW_STEP + 2.2);
  rows.push(frontAisle());
  return rows;
}

function aisleNear(y: number): number {
  let best = TOP_AISLE;
  for (const row of aisles()) if (Math.abs(row - y) < Math.abs(best - y)) best = row;
  return best;
}

/** Caminho em L pelos corredores, sem atravessar mesas. */
function route(from: Point, to: Point, toAisle?: number): Point[] {
  const a = aisleNear(from.y);
  const b = toAisle ?? aisleNear(to.y);
  const points: Point[] = [{ x: from.x, y: a }];
  if (a !== b) points.push({ x: LANE_X, y: a }, { x: LANE_X, y: b });
  points.push({ x: to.x, y: b }, { ...to });
  return points;
}

// --- Pontos de pausa -------------------------------------------------------

export type CafeActivity = 'bebedouro' | 'cafe' | 'fliperama' | 'sinuca' | 'conversa';
type SpotKind = CafeActivity;

interface Spot {
  readonly id: string;
  readonly kind: SpotKind;
  readonly at: Point;
  /** Altura do assento (banqueta). */
  readonly z: number;
  readonly anim: string;
  readonly view: 'front' | 'back';
  /** Corredor de chegada, quando não é o mais perto. */
  readonly aisle?: number;
}

function spots(): Spot[] {
  const f = front();
  return [
    {
      id: 'bebedouro-0',
      kind: 'bebedouro',
      at: { x: 1.3, y: 1.2 },
      z: 0,
      anim: 'agent-drink-water',
      view: 'back',
    },
    {
      id: 'bebedouro-1',
      kind: 'bebedouro',
      at: { x: 2.15, y: 1.6 },
      z: 0,
      anim: 'agent-drink-water',
      view: 'back',
    },
    ...[3.5, 4.6, 5.7].map((x, i): Spot => ({
      id: `cafe-${String(i)}`,
      kind: 'cafe',
      at: { x, y: 2.35 },
      z: 11,
      anim: 'agent-drink-coffee',
      view: 'back',
    })),
    {
      id: 'fliperama',
      kind: 'fliperama',
      at: { x: 13.4, y: 1.25 },
      z: 0,
      anim: 'agent-arcade',
      view: 'back',
    },
    {
      id: 'sinuca-0',
      kind: 'sinuca',
      at: { x: 11.65, y: f + 1.1 },
      z: 0,
      anim: 'agent-pool',
      view: 'front',
    },
    {
      id: 'sinuca-1',
      kind: 'sinuca',
      at: { x: 10.0, y: f + 1.95 },
      z: 0,
      anim: 'agent-pool',
      view: 'front',
      aisle: frontAisle(),
    },
    ...[2.1, 3.1].map((x, i): Spot => ({
      id: `conversa-${String(i)}`,
      kind: 'conversa',
      at: { x, y: f + 0.85 },
      z: 0,
      anim: 'agent-sofa-chat',
      view: 'front',
      aisle: frontAisle(),
    })),
  ];
}

// --- Cores -----------------------------------------------------------------

export const PROVIDER_COLORS: Record<string, [string, string]> = {
  anthropic: ['#d97757', '#a8553a'],
  openai: ['#10a37f', '#0b7258'],
  google: ['#4285f4', '#2a5fb8'],
  gemini: ['#4285f4', '#2a5fb8'],
  ollama: ['#e8e8e8', '#a9a9a9'],
  lmstudio: ['#6e7cff', '#4a55c4'],
  lovable: ['#ff5c8a', '#c23b62'],
};
export const OTHER_COLORS: [string, string] = ['#9b6bd6', '#6c45a0'];
const HAIR = ['#2b1d14', '#4a2f1b', '#c58f4b', '#1b1b1b', '#7a3b1e', '#d9c27a', '#5a5a5a'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --- Avatares --------------------------------------------------------------

type Phase =
  | 'entrando'
  | 'sentado'
  | 'comemorando'
  | 'entregando'
  | 'indo-pausa'
  | 'pausa'
  | 'voltando'
  | 'saindo';

interface Avatar {
  agent: CafeAgent;
  slot: number;
  pos: Point;
  path: Point[];
  phase: Phase;
  /** Fim da pausa, da entrega ou da comemoração (ms do relógio da sala). */
  until: number;
  celebrateUntil: number;
  spot?: Spot;
  /** Para onde foi a pausa depois de comemorar. */
  pendingBreak?: boolean;
  /** Volta ao PC depois de entregar o papel a este agente. */
  deliveringTo?: string;
  thumb?: AgentThumbnailEventData;
  /** Desde quando está ocioso sentado (para cochilar). */
  idleSince: number;
  arrivedAt: number;
  walked: number;
  facing: number;
  look: string;
  swaps: Map<string, string>;
  seed: number;
}

const FINAL: ReadonlySet<AgentState> = new Set(['concluído', 'parado']);
const ALL_FINAL: ReadonlySet<AgentState> = new Set(['concluído', 'parado', 'falhou']);
const SLEEP_AFTER = 90_000;

const avatars = new Map<string, Avatar>();
/** PCs: id da sessão sentada ali, ou vazio. */
const slots: (string | undefined)[] = [];
let score: CafeScore | undefined;
let limits = new Set<string>();
let bellUntil = 0;
let loaded = false;
let offline = false;
let now = 0;
let hourOverride: number | undefined;

export function isMaestro(agent: CafeAgent): boolean {
  return agent.papel === 'maestro';
}

function freeSlot(): number {
  const index = slots.findIndex((s) => s === undefined);
  if (index >= 0) return index;
  slots.push(undefined);
  return slots.length - 1;
}

function resizeRoom(): void {
  roomH = Math.max(13, front() + 3);
}

function looks(agent: CafeAgent, seed: number): { look: string; swaps: Map<string, string> } {
  const [shirt, shirtDark] = PROVIDER_COLORS[agent.provedor] ?? OTHER_COLORS;
  const skin = SKIN[(seed >>> 8) % SKIN.length] ?? '#f1c27d';
  const hair = HAIR[seed % HAIR.length] ?? '#222222';
  return {
    look: `${shirt}${skin}${hair}`,
    swaps: new Map([
      [KEY.shirt, shirt],
      [KEY.shirtDark, shirtDark],
      [KEY.skin, skin],
      [KEY.skinDark, shade(skin, -0.2)],
      [KEY.hair, hair],
      [KEY.hairDark, shade(hair, -0.35)],
    ]),
  };
}

function addAvatar(agent: CafeAgent, entering: boolean): Avatar {
  const slot = freeSlot();
  slots[slot] = agent.sessionId;
  resizeRoom();
  const seed = hash(agent.sessionId);
  const chair = chairOf(slot);
  const avatar: Avatar = {
    agent,
    slot,
    pos: entering ? door() : { ...chair },
    path: entering ? route(door(), chair) : [],
    phase: entering ? 'entrando' : 'sentado',
    until: 0,
    celebrateUntil: 0,
    idleSince: now,
    arrivedAt: now,
    walked: 0,
    facing: 2,
    seed,
    ...looks(agent, seed),
    ...(agent.miniatura ? { thumb: agent.miniatura } : {}),
  };
  avatars.set(agent.sessionId, avatar);
  // O maestro anda até o PC do agente que acabou de criar e entrega o papel.
  const parent = agent.parentSessionId ? avatars.get(agent.parentSessionId) : undefined;
  if (entering && parent?.phase === 'sentado') {
    const desk = deskOf(slot);
    parent.phase = 'entregando';
    parent.deliveringTo = agent.sessionId;
    parent.path = route(parent.pos, { x: desk.x + DESK_W + 0.3, y: desk.y + 1.4 });
    parent.until = 0;
  }
  return avatar;
}

function taken(spot: Spot, except?: Avatar): boolean {
  for (const a of avatars.values()) if (a !== except && a.spot?.id === spot.id) return true;
  return false;
}

function freeSpot(avatar: Avatar): Spot | undefined {
  const list = spots();
  const free = list.filter((s) => !taken(s, avatar));
  // Conversa, sinuca ou bebedouro com quem já está sozinho lá.
  const company = free.find(
    (s) =>
      (s.kind === 'conversa' || s.kind === 'sinuca' || s.kind === 'bebedouro') &&
      list.some((o) => o.kind === s.kind && o.id !== s.id && taken(o, avatar)),
  );
  const roll = hash(`${avatar.agent.sessionId}:${String(Math.floor(now))}`);
  if (company && roll % 2 === 0) return company;
  const kinds = [...new Set(free.map((s) => s.kind))];
  const kind = kinds[(roll >>> 4) % Math.max(1, kinds.length)];
  return free.find((s) => s.kind === kind);
}

function startBreak(avatar: Avatar): void {
  if (avatar.phase === 'pausa' || avatar.phase === 'indo-pausa' || avatar.phase === 'saindo')
    return;
  slots[avatar.slot] = undefined;
  const spot = freeSpot(avatar);
  if (!spot) {
    leave(avatar);
    return;
  }
  avatar.spot = spot;
  avatar.path = route(avatar.pos, spot.at, spot.aisle);
  avatar.phase = 'indo-pausa';
  // Pausa de 20 a 60 s (SDD 13.1); só visual, a sessão já terminou.
  avatar.until = 20_000 + (avatar.seed % 40_000);
}

function setActivity(sessionId: string, kind: SpotKind, durationMs: number): boolean {
  const avatar = avatars.get(sessionId);
  if (
    avatar?.agent.state !== 'ocioso' ||
    avatar.phase !== 'sentado' ||
    !Number.isFinite(durationMs) ||
    durationMs < 60_000 ||
    durationMs > 60 * 60_000
  )
    return false;
  const spot = spots().find((candidate) => candidate.kind === kind && !taken(candidate, avatar));
  if (!spot) return false;
  slots[avatar.slot] = undefined;
  avatar.spot = spot;
  avatar.path = route(avatar.pos, spot.at, spot.aisle);
  avatar.phase = 'indo-pausa';
  avatar.until = durationMs;
  return true;
}

/** Concluiu: levanta, comemora um pouco e só então vai para a pausa. */
function celebrate(avatar: Avatar): void {
  if (avatar.phase !== 'sentado') {
    startBreak(avatar);
    return;
  }
  avatar.phase = 'comemorando';
  avatar.pos = { x: avatar.pos.x + 0.25, y: avatar.pos.y + 0.35 };
  avatar.celebrateUntil = now + 2_600;
  avatar.until = now + 2_600;
}

function finish(avatar: Avatar): void {
  if (avatar.agent.state === 'concluído') celebrate(avatar);
  else startBreak(avatar);
}

function leave(avatar: Avatar): void {
  if (avatar.phase === 'saindo') return;
  if (slots[avatar.slot] === avatar.agent.sessionId) slots[avatar.slot] = undefined;
  delete avatar.spot;
  avatar.phase = 'saindo';
  avatar.path = route(avatar.pos, door(), frontAisle());
}

function applyState(state: CafeState): void {
  score = state.placar;
  limits = new Set(state.limites);
  const seen = new Set<string>();
  // Pais antes dos filhos, para a entrega do papel achar o maestro sentado.
  const ordered = [...state.agentes].sort(
    (a, b) => Number(Boolean(a.parentSessionId)) - Number(Boolean(b.parentSessionId)),
  );
  for (const agent of ordered) {
    seen.add(agent.sessionId);
    const avatar = avatars.get(agent.sessionId);
    if (avatar) {
      const before = avatar.agent.state;
      avatar.agent = agent;
      if (agent.miniatura) avatar.thumb = agent.miniatura;
      if (before !== agent.state) stateChanged(avatar, before);
      if (FINAL.has(agent.state) && avatar.phase === 'sentado') finish(avatar);
      continue;
    }
    // Ao abrir a sala, quem já está trabalhando aparece sentado; quem chega
    // depois entra pela porta. Sessões já encerradas não aparecem.
    if (ALL_FINAL.has(agent.state) && !loaded) continue;
    if (FINAL.has(agent.state)) continue;
    addAvatar(agent, loaded);
  }
  for (const avatar of avatars.values()) {
    if (
      !seen.has(avatar.agent.sessionId) &&
      avatar.phase !== 'pausa' &&
      avatar.phase !== 'indo-pausa' &&
      avatar.phase !== 'comemorando'
    ) {
      leave(avatar);
    }
  }
  loaded = true;
  changed();
}

function stateChanged(avatar: Avatar, before: AgentState): void {
  if (avatar.agent.state === 'ocioso' && before !== 'ocioso') avatar.idleSince = now;
}

let refreshAsked = 0;
function askRefresh(): void {
  if (now - refreshAsked < 500) return;
  refreshAsked = now;
  options.onRefresh();
}

function onEvent(event: FaklEvent): void {
  switch (event.topic) {
    case 'agent.state': {
      const data = event.data as AgentStateEventData;
      const avatar = avatars.get(event.subject);
      if (!avatar) {
        if (!ALL_FINAL.has(data.state)) askRefresh();
        return;
      }
      const before = avatar.agent.state;
      avatar.agent = { ...avatar.agent, state: data.state };
      stateChanged(avatar, before);
      if (FINAL.has(data.state)) finish(avatar);
      changed();
      return;
    }
    case 'agent.thumbnail': {
      const avatar = avatars.get(event.subject);
      if (!avatar) return;
      avatar.thumb = event.data as AgentThumbnailEventData;
      changed();
      return;
    }
    case 'run.round': {
      const data = event.data as { veredito?: string };
      if (data.veredito !== 'passou') return;
      for (const avatar of avatars.values()) {
        if (avatar.agent.runId === event.subject) avatar.celebrateUntil = now + 2_500;
      }
      return;
    }
    case 'run.limit':
      if (!limits.has(event.subject)) {
        limits.add(event.subject);
        bellUntil = now + 1_800;
        ring();
      }
      return;
    case 'run.done':
      limits.delete(event.subject);
      return;
    default:
      return;
  }
}

/** Sino do relógio da parede; o navegador pode bloquear o som sem um clique antes. */
function ring(): void {
  try {
    const audio = new AudioContext();
    for (const [delay, freq] of [
      [0, 1318],
      [0.18, 988],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.06, audio.currentTime + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + delay + 0.6);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + delay);
      osc.stop(audio.currentTime + delay + 0.7);
    }
    setTimeout(() => void audio.close(), 1_500);
  } catch {
    // Sem áudio, fica só o relógio vermelho.
  }
}

// --- Gato ------------------------------------------------------------------

interface Cat {
  pos: Point;
  path: Point[];
  until: number;
  mode: 'andando' | 'sentado' | 'dormindo' | 'colo';
  flip: boolean;
  walked: number;
  /** Sessão de quem está cochilando e ganhou o gato no colo (ou para onde ele vai). */
  lap?: string;
}

const cat: Cat = {
  pos: { x: 2.6, y: 12.4 },
  path: [],
  until: 6_000,
  mode: 'sentado',
  flip: false,
  walked: 0,
};

function catSpots(): Point[] {
  const f = front();
  return [
    { x: 2.8, y: f + 1.3 },
    { x: 1.9, y: 1.4 },
    { x: 12.6, y: 1.5 },
    { x: 8.3, y: f + 1.0 },
    { x: 14.6, y: f + 2.0 },
    { x: 0.9, y: 4.6 },
    { x: 7.0, y: TOP_AISLE },
  ];
}

function stepCat(dt: number): void {
  const target = cat.path[0];
  if (target) {
    const dx = target.x - cat.pos.x;
    const dy = target.y - cat.pos.y;
    const dist = Math.hypot(dx, dy);
    const move = (1.1 * dt) / 1000;
    if (Math.abs(dx - dy) > 0.01) cat.flip = dx - dy < 0;
    if (dist <= move) {
      cat.pos = { ...target };
      cat.path.shift();
    } else {
      cat.pos = { x: cat.pos.x + (dx / dist) * move, y: cat.pos.y + (dy / dist) * move };
    }
    cat.walked += move;
    if (cat.path.length === 0) {
      const owner = cat.lap === undefined ? undefined : avatars.get(cat.lap);
      if (owner && sleeping(owner)) {
        cat.mode = 'colo';
        cat.pos = { ...owner.pos };
        return;
      }
      delete cat.lap;
      const night = daylight(hour()) < 0.3;
      const onRug = Math.abs(cat.pos.x - 2.8) < 0.2;
      cat.mode = night || onRug ? 'dormindo' : 'sentado';
      cat.until = now + (cat.mode === 'dormindo' ? 25_000 : 5_000 + (Math.floor(now) % 7) * 1_000);
    }
    return;
  }
  if (cat.mode === 'colo') {
    const owner = cat.lap === undefined ? undefined : avatars.get(cat.lap);
    if (owner && sleeping(owner)) return;
    // Acordou: o gato pula do colo e vai embora.
    delete cat.lap;
    cat.mode = 'sentado';
    cat.until = now;
  }
  if (now < cat.until) return;
  // Quem cochila ganha companhia na maior parte das vezes.
  const sleeper = [...avatars.values()].find((a) => sleeping(a) && a.path.length === 0);
  if (sleeper && Math.floor(now / 977) % 3 !== 0) {
    cat.mode = 'andando';
    cat.lap = sleeper.agent.sessionId;
    cat.path = route(cat.pos, sleeper.pos);
    return;
  }
  const list = catSpots();
  const next = list[Math.floor(now / 977) % list.length] ?? list[0];
  if (!next) return;
  cat.mode = 'andando';
  cat.path = route(cat.pos, next);
}

// --- Bolas de sinuca -------------------------------------------------------

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const balls: Ball[] = [
  { x: 0.6, y: 0.6, vx: 0, vy: 0 },
  { x: 1.5, y: 0.45, vx: 0, vy: 0 },
  { x: 1.6, y: 0.75, vx: 0, vy: 0 },
];
let nextShot = 0;

function stepBalls(dt: number): void {
  const playing = [...avatars.values()].some(
    (a) => a.phase === 'pausa' && a.spot?.kind === 'sinuca',
  );
  if (playing && now >= nextShot) {
    const ball = balls[0];
    if (ball) {
      ball.vx = 0.9 + ((now / 1000) % 0.5);
      ball.vy = ((now / 333) % 1) - 0.5;
    }
    nextShot = now + 3_500;
  }
  const s = dt / 1000;
  for (const b of balls) {
    b.x += b.vx * s;
    b.y += b.vy * s;
    if (b.x < 0.2 || b.x > 1.9) {
      b.vx = -b.vx;
      b.x = Math.min(1.9, Math.max(0.2, b.x));
    }
    if (b.y < 0.2 || b.y > 0.95) {
      b.vy = -b.vy;
      b.y = Math.min(0.95, Math.max(0.2, b.y));
    }
    b.vx *= 1 - 1.2 * s;
    b.vy *= 1 - 1.2 * s;
  }
  // Colisão simples: a bola branca empurra as outras.
  const [cue, ...rest] = balls;
  if (!cue) return;
  for (const b of rest) {
    const dx = b.x - cue.x;
    const dy = b.y - cue.y;
    if (Math.hypot(dx, dy) < 0.12 && Math.hypot(cue.vx, cue.vy) > 0.05) {
      b.vx = cue.vx * 0.8;
      b.vy = cue.vy * 0.8 + dy;
      cue.vx *= 0.2;
      cue.vy *= 0.2;
    }
  }
}

// --- Placar do fliperama --------------------------------------------------

const arcade = {
  player: undefined as string | undefined,
  score: 0,
  carry: 0,
  record: 2_500,
  /** Até quando o placar da última partida fica na tela. */
  showUntil: 0,
  /** Até quando pisca o recorde novo. */
  recordUntil: 0,
};

function stepArcade(dt: number): void {
  const player = [...avatars.values()].find(
    (a) => a.phase === 'pausa' && a.spot?.kind === 'fliperama' && a.path.length === 0,
  );
  if (player) {
    if (arcade.player !== player.agent.sessionId) {
      arcade.player = player.agent.sessionId;
      arcade.score = 0;
      arcade.carry = 0;
    }
    // Cada jogador tem o seu ritmo; uns batem o recorde, outros não.
    arcade.carry += (dt * (35 + (player.seed % 7) * 14)) / 1000;
    const points = Math.floor(arcade.carry / 10) * 10;
    arcade.carry -= points;
    const before = arcade.score;
    arcade.score = Math.min(9_999, arcade.score + points);
    if (before <= arcade.record && arcade.score > arcade.record) arcade.recordUntil = now + 3_000;
    return;
  }
  if (arcade.player !== undefined) {
    arcade.record = Math.max(arcade.record, arcade.score);
    arcade.player = undefined;
    arcade.showUntil = now + 6_000;
  }
}

/** Visor em cima do fliperama: pontos de quem joga, ou o recorde da casa. */
function drawArcadeScore(): void {
  const c = iso(13.4, 0.55, 58);
  const x = Math.round(c.x - 10);
  const y = Math.round(c.y - 5);
  ctx.fillStyle = C.out;
  ctx.fillRect(x, y, 21, 11);
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(x + 1, y + 1, 19, 9);
  const playing = arcade.player !== undefined;
  const blink = Math.floor(now / 200) % 2 === 0;
  let value: string;
  let color: string;
  if (now < arcade.recordUntil) {
    value = String(arcade.score).padStart(4, '0');
    color = blink ? C.pink : C.yellow;
  } else if (playing || now < arcade.showUntil) {
    value = String(arcade.score).padStart(4, '0');
    color = C.yellow;
  } else {
    // Sem ninguém jogando, alterna "HI" e o recorde.
    const hi = Math.floor(now / 1_500) % 3 === 0;
    value = hi ? ' HI ' : String(arcade.record).padStart(4, '0');
    color = C.neon;
  }
  ctx.fillStyle = color;
  text(value, (u, v) => {
    ctx.fillRect(x + 3 + u, y + 3 + v, 1, 1);
  });
  if (now < arcade.recordUntil)
    emotes.push({ x: c.x - 3, y: c.y - 8, id: 'emote-confetti', frame: Math.floor(now / 200) % 3 });
}

// --- Movimento -------------------------------------------------------------

function step(dt: number): void {
  for (const avatar of [...avatars.values()]) {
    if (
      avatar.phase === 'sentado' &&
      avatar.agent.state === 'ocioso' &&
      now - avatar.idleSince > (options.sleepAfterMs ?? SLEEP_AFTER)
    ) {
      if (freeSpot(avatar)) startBreak(avatar);
    }
    const target = avatar.path[0];
    if (target) {
      const dx = target.x - avatar.pos.x;
      const dy = target.y - avatar.pos.y;
      const dist = Math.hypot(dx, dy);
      const move = (SPEED * dt) / 1000;
      if (dist > 0.001) {
        // Linha da folha de andar: baixo-direita, baixo-esquerda, cima-direita, cima-esquerda.
        avatar.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 3) : dy > 0 ? 1 : 2;
      }
      avatar.walked += Math.min(move, dist);
      if (dist <= move) {
        avatar.pos = { ...target };
        avatar.path.shift();
      } else {
        avatar.pos = { x: avatar.pos.x + (dx / dist) * move, y: avatar.pos.y + (dy / dist) * move };
      }
      if (avatar.path.length > 0) continue;
      arrive(avatar);
      continue;
    }
    if (avatar.phase === 'comemorando' && now >= avatar.until) {
      avatar.phase = 'sentado';
      startBreak(avatar);
    }
    if (avatar.phase === 'pausa' && now >= avatar.until) {
      if (!FINAL.has(avatar.agent.state)) {
        avatar.slot = freeSlot();
        slots[avatar.slot] = avatar.agent.sessionId;
        avatar.phase = 'voltando';
        avatar.path = route(avatar.pos, chairOf(avatar.slot));
      } else leave(avatar);
    }
    if (avatar.phase === 'entregando' && avatar.until > 0 && now >= avatar.until) {
      delete avatar.deliveringTo;
      avatar.phase = 'entrando';
      avatar.path = route(avatar.pos, chairOf(avatar.slot));
    }
  }
  stepCat(dt);
  stepBalls(dt);
  stepArcade(dt);
}

function arrive(avatar: Avatar): void {
  avatar.arrivedAt = now;
  switch (avatar.phase) {
    case 'entrando':
      avatar.phase = 'sentado';
      avatar.idleSince = now;
      if (FINAL.has(avatar.agent.state)) finish(avatar);
      return;
    case 'entregando':
      avatar.until = now + 1_800;
      return;
    case 'indo-pausa':
      avatar.phase = 'pausa';
      avatar.until = now + avatar.until;
      return;
    case 'voltando':
      avatar.phase = 'sentado';
      avatar.idleSince = now;
      return;
    case 'saindo':
      avatars.delete(avatar.agent.sessionId);
      changed();
      return;
    default:
      return;
  }
}

// --- Hora do dia -----------------------------------------------------------

function hour(): number {
  if (hourOverride !== undefined) return hourOverride;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

/** 0 à noite, 1 de dia, com amanhecer e entardecer de duas horas. */
function daylight(h: number): number {
  if (h < 5.5 || h >= 19.5) return 0;
  if (h < 7.5) return (h - 5.5) / 2;
  if (h < 17.5) return 1;
  return 1 - (h - 17.5) / 2;
}

/** Quanto de laranja do pôr (ou rosa do nascer) do sol, de 0 a 1. */
function golden(h: number): number {
  const dusk = Math.max(0, 1 - Math.abs(h - 18.4) / 1.3);
  const dawn = Math.max(0, 1 - Math.abs(h - 6.4) / 1.1);
  return Math.max(dusk, dawn * 0.8);
}

// --- Desenho ---------------------------------------------------------------

let canvas: HTMLCanvasElement;
let screenCtx: CanvasRenderingContext2D;
let buffer: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let artW = 0;
let artH = 0;
let blit = { x: 0, y: 0, s: 1 };

function changed(): void {
  options.onChange?.();
}

let staticLayer: HTMLCanvasElement | undefined;
let staticKey = '';

const windowsY = [2, 6];
const doorY = (): number => roomH - 2;

function floorTile(x: number, y: number): string {
  const f = front();
  if (y < 3) return 'floor-wood';
  if (y < f - 0.5 && x >= 2 && x < 14) return 'floor-carpet';
  return (x + y) % 2 === 0 ? 'floor-a' : 'floor-b';
}

/** Piso e paredes, que só mudam quando a sala cresce ou chega um PNG. */
function drawStatic(): void {
  const key = `${String(roomH)}|${String(spritesVersion())}|${String(artW)}x${String(artH)}`;
  if (staticLayer && staticKey === key) {
    ctx.drawImage(staticLayer, 0, 0);
    return;
  }
  staticLayer = newCanvas(artW, artH);
  const g = context(staticLayer);
  for (let x = 0; x < ROOM_W; x++) {
    for (let y = 0; y < roomH; y++) {
      const p = iso(x, y);
      draw(g, floorTile(x, y), p.x, p.y);
    }
  }
  for (let x = 0; x < ROOM_W; x++) {
    const p = iso(x, roomH);
    draw(g, 'floor-edge-left', p.x, p.y);
  }
  for (let y = 0; y < roomH; y++) {
    const p = iso(ROOM_W, y);
    draw(g, 'floor-edge-right', p.x, p.y);
  }
  for (let x = 0; x < ROOM_W; x++) {
    const p = iso(x, 0);
    draw(g, 'wall-back', p.x, p.y);
  }
  const skip = new Set<number>();
  for (const wy of [...windowsY, doorY()]) {
    skip.add(wy);
    skip.add(wy + 1);
  }
  for (let y = 0; y < roomH; y++) {
    if (skip.has(y)) continue;
    const p = iso(0, y);
    draw(g, 'wall-left', p.x, p.y);
  }
  // Quina das paredes.
  const corner = iso(0, 0);
  g.fillStyle = C.cap;
  g.fillRect(corner.x - 1, corner.y - WALL_H, 2, WALL_H);
  g.fillStyle = C.capLight;
  g.fillRect(corner.x - 1, corner.y - WALL_H, 1, WALL_H);
  staticKey = key;
  ctx.drawImage(staticLayer, 0, 0);
}

function lerpColor(a: string, b: string, t: number): string {
  return mix(a, b, Math.max(0, Math.min(1, t)));
}

/** Céu atrás do vidro: degradê em faixas, estrelas, sol ou lua e a cidade. */
function sky(g: CanvasRenderingContext2D, w: number, h: number, shift: number): void {
  const hr = hour();
  const day = daylight(hr);
  const gold = golden(hr);
  let top = lerpColor('#0b1026', '#3b82f6', day);
  let bottom = lerpColor('#1e2a5a', '#bfdbfe', day);
  top = lerpColor(top, '#6d28d9', gold * 0.6);
  bottom = lerpColor(bottom, '#fb923c', gold * 0.85);
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = lerpColor(top, bottom, i / (bands - 1));
    g.fillRect(0, Math.floor((i * h) / bands), w, Math.ceil(h / bands) + 1);
  }
  if (day < 0.5) {
    g.fillStyle = '#e0e7ff';
    for (let i = 0; i < 9; i++) {
      const x = (i * 7 + shift * 3) % w;
      const y = (i * 5 + shift) % Math.max(1, h - 20);
      if ((Math.floor(now / 700) + i) % 5 !== 0) g.fillRect(x, y, 1, 1);
    }
  }
  // Sol de dia, lua à noite, cruzando o vidro com a hora.
  const t = day > 0 ? (hr - 5.5) / 14 : ((hr + 24 - 19.5) % 24) / 10;
  const bx = Math.round(-shift * 0.6 + t * (w + 20) - 10);
  const by = Math.round(h * 0.45 - Math.sin(t * Math.PI) * h * 0.35);
  draw(g, day > 0 ? 'sky-sun' : 'sky-moon', bx, by);
  if (day > 0.3) {
    g.fillStyle = '#f8fafc';
    const cx = Math.round(((now / 900 + shift * 5) % (w + 16)) - 8);
    g.fillRect(cx, 6, 7, 2);
    g.fillRect(cx + 2, 5, 4, 1);
  }
  const city = sheet('skyline');
  const def = spriteDef('skyline');
  const frame = day >= 0.5 ? 0 : 1;
  g.drawImage(
    city,
    frame * def.w + (shift % 8),
    0,
    def.w - 8,
    def.h,
    0,
    h - def.h + 22,
    def.w - 8,
    def.h,
  );
}

function drawWallDecor(): void {
  // Janelas e porta da parede da esquerda.
  windowsY.forEach((wy, i) => {
    const anchor = iso(0, wy);
    const def = spriteDef('wall-left-window');
    drawInHole(ctx, 'wall-left-window', 0, anchor.x - def.ax, anchor.y - def.ay, (g, w, h) => {
      sky(g, w, h, i * 11);
    });
    draw(ctx, 'wall-left-window', anchor.x, anchor.y);
  });
  const near = [...avatars.values()].some(
    (a) => a.path.length > 0 && Math.hypot(a.pos.x - door().x, a.pos.y - door().y) < 1.3,
  );
  const d = iso(0, doorY());
  draw(ctx, near ? 'wall-left-door-open' : 'wall-left-door', d.x, d.y);
  const poster = iso(0, 5.4, 18);
  draw(ctx, 'poster', poster.x, poster.y);
  // Parede do fundo.
  const menu = iso(5.4, 0, 24);
  draw(ctx, 'menu-board', menu.x, menu.y);
  const neon = iso(7.75, 0, 34);
  const flicker = Math.floor(now / 140) % 53 === 0 || Math.floor(now / 140) % 53 === 2;
  draw(ctx, 'neon-sign', neon.x, neon.y, flicker ? 1 : 0);
  drawClock();
  drawScoreboard();
}

function px(x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

function pixelLine(x0: number, y0: number, x1: number, y1: number, color: string): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++)
    px(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, color);
}

function drawClock(): void {
  const red = limits.size > 0;
  const shake = now < bellUntil ? Math.round(Math.sin(now / 25) * 1.5) : 0;
  const c = iso(9.1, 0, 56);
  const x = c.x + shake;
  draw(ctx, 'wall-clock', x, c.y);
  if (red) {
    const color = Math.floor(now / 400) % 2 ? '#ff3b3b' : '#b31d1d';
    ctx.fillStyle = color;
    for (let dy = -5; dy <= 5; dy++) {
      const half = Math.round(4.6 * Math.sqrt(1 - (dy * dy) / 36));
      ctx.fillRect(x - half + 1, c.y + dy, half * 2, 1);
    }
  }
  const date = new Date();
  const hr = hour();
  const hours = (hr % 12) * (Math.PI / 6);
  const minutes = (hourOverride !== undefined ? (hr % 1) * 60 : date.getMinutes()) * (Math.PI / 30);
  const hand = red ? '#ffffff' : C.ink;
  const cx = x + 0.5;
  const cy = c.y + 0.5;
  pixelLine(cx, cy, cx + Math.sin(hours) * 3, cy - Math.cos(hours) * 3, hand);
  pixelLine(cx, cy, cx + Math.sin(minutes) * 4.5, cy - Math.cos(minutes) * 4.5, hand);
  px(cx, cy, C.red);
}

function money(value: number): string {
  return value.toFixed(2);
}

/** Placar do dia na parede do fundo (RF-606): ícones e números em pixel. */
function drawScoreboard(): void {
  const a = iso(9.9, 0, 18);
  draw(ctx, 'scoreboard', a.x, a.y);
  const put = (u: number, v: number, color: string) => {
    px(a.x + u, a.y + Math.floor(u / 2) - v, color);
  };
  const rows: [number, string, (u: number, v: number) => void][] = [
    [
      19,
      String(score?.tarefas ?? 0),
      (u, v) => {
        // Visto verde.
        put(u, v - 3, C.green);
        put(u + 1, v - 4, C.green);
        put(u + 2, v - 3, C.green);
        put(u + 3, v - 2, C.green);
        put(u + 4, v - 1, C.green);
      },
    ],
    [
      13,
      String(score?.prs ?? 0),
      (u, v) => {
        // Galho de PR.
        for (let i = 0; i < 5; i++) put(u + 1, v - i, C.purpleLight);
        put(u + 3, v, C.purpleLight);
        put(u + 3, v - 1, C.purpleLight);
        put(u + 2, v - 2, C.purpleLight);
      },
    ],
    [
      7,
      money(score?.custoUsd ?? 0),
      (u, v) => {
        // Moeda.
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) put(u + 1 + i, v - j, C.yellow);
        put(u + 2, v - 1, '#b45309');
      },
    ],
  ];
  for (const [v, value, icon] of rows) {
    icon(4, v);
    // Cada letra fica em pé; só a linha de base acompanha a inclinação da parede.
    Array.from(value).forEach((ch, i) => {
      const u = 11 + i * 4;
      text(ch, (x, y) => {
        px(a.x + u + x, a.y + Math.floor(u / 2) - v + y, C.text);
      });
    });
  }
  // Conquistas em cima da estante do bar: 5 agentes numa execução e 100 PRs.
  const five = (score?.maxAgentes ?? 0) >= 5;
  const hundred = (score?.prsTotal ?? 0) >= 100;
  const t1 = iso(3.25, 0.2, 47);
  const t2 = iso(3.75, 0.2, 47);
  draw(ctx, five ? 'trophy-five-agents' : 'trophy-locked', t1.x, t1.y);
  draw(ctx, hundred ? 'trophy-hundred-prs' : 'trophy-locked', t2.x, t2.y);
}

// --- Telas dos monitores ---------------------------------------------------

function drawThumb(
  g: CanvasRenderingContext2D,
  thumb: AgentThumbnailEventData,
  avatar: Avatar,
): void {
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
  rect(0, 0, 21, 15, '#0f1726');
  if (thumb.tipo === 'testes') {
    const color =
      thumb.resultado === 'ok' ? '#2ecc71' : thumb.resultado === 'falhou' ? '#e74c3c' : '#f1c40f';
    const width = thumb.resultado === 'rodando' ? 2 + Math.floor((now / 120) % 17) : 19;
    rect(1, 6, 19, 3, '#1d2635');
    rect(1, 6, width, 3, color);
    return;
  }
  const lines = thumb.linhas.length > 0 ? thumb.linhas : [thumb.titulo];
  const typing = avatar.agent.state === 'executando' ? Math.floor(now / 300) % 3 : 0;
  const shown = lines.slice(-6);
  rect(0, 0, 21, 2, '#24324a');
  rect(1, 0, 1, 1, C.red);
  rect(3, 0, 1, 1, C.yellow);
  rect(5, 0, 1, 1, C.green);
  shown.forEach((line, i) => {
    let color = '#8fa3bf';
    if (thumb.tipo === 'arquivo')
      color = line.startsWith('+') ? '#3fbf6f' : line.startsWith('-') ? '#e05d5d' : '#8fa3bf';
    else if (thumb.tipo === 'comando') color = i === 0 ? '#f1c40f' : '#b8c4d6';
    else if (thumb.tipo === 'pensando') color = '#c59cff';
    else if (thumb.tipo === 'resposta') color = '#e8e8e8';
    const width = Math.max(
      2,
      Math.min(19, Math.round(line.length / 3.2) - (i === shown.length - 1 ? typing : 0)),
    );
    rect(1 + (hash(line) % 3 === 0 ? 2 : 0), 3 + i * 2, width, 1, color);
  });
  if (avatar.agent.state === 'executando' && Math.floor(now / 400) % 2) {
    const last = shown.length - 1;
    rect(
      Math.min(19, 2 + Math.round((shown[last]?.length ?? 0) / 3.2)),
      3 + last * 2,
      1,
      1,
      C.neon,
    );
  }
}

/** O que o monitor do PC mostra agora. */
function screenOf(avatar: Avatar | undefined): (g: CanvasRenderingContext2D) => void {
  const still = (id: string, frame: number) => (g: CanvasRenderingContext2D) => {
    const def = spriteDef(id);
    g.drawImage(sheet(id), (frame % def.frames) * def.w, 0, def.w, def.h, 0, 0, def.w, def.h);
  };
  if (!avatar) return still('screen-off', 0);
  if (avatar.phase !== 'sentado' && avatar.phase !== 'comemorando') {
    return avatar.phase === 'saindo'
      ? still('screen-off', 0)
      : still('screen-saver', Math.floor(now / 350));
  }
  const state = avatar.agent.state;
  if (state === 'preparando' || now - avatar.arrivedAt < 1_400)
    return still('screen-boot', Math.floor(now / 350));
  if (state === 'falhou' && Math.floor(now / 1_200) % 2 === 0)
    return still('screen-error', Math.floor(now / 300));
  if (sleeping(avatar)) return still('screen-saver', Math.floor(now / 350));
  const thumb = avatar.thumb;
  if (!thumb) {
    return state === 'ocioso' || state === 'pausado'
      ? still('screen-saver', Math.floor(now / 350))
      : still('screen-boot', 3);
  }
  return (g) => {
    drawThumb(g, thumb, avatar);
  };
}

function sleeping(avatar: Avatar): boolean {
  return (
    avatar.phase === 'sentado' &&
    avatar.agent.state === 'ocioso' &&
    now - avatar.idleSince > (options.sleepAfterMs ?? SLEEP_AFTER)
  );
}

// --- Itens da cena ---------------------------------------------------------

interface Drawable {
  depth: number;
  draw: () => void;
}

function prop(id: string, x: number, y: number, depth?: number, frame = 0, z = 0): Drawable {
  const p = iso(x, y, z);
  return {
    depth: depth ?? x + y + 0.5,
    draw: () => {
      draw(ctx, id, p.x, p.y, frame);
    },
  };
}

function drawDesk(index: number): void {
  const desk = deskOf(index);
  const sessionId = slots[index];
  const avatar = sessionId ? avatars.get(sessionId) : undefined;
  const p = iso(desk.x, desk.y);
  draw(ctx, 'desk', p.x, p.y);
  const m = iso(desk.x + 0.62, desk.y + 0.22, 14);
  const def = spriteDef('monitor-front');
  drawInHole(ctx, 'monitor-front', 0, m.x - def.ax, m.y - def.ay, screenOf(avatar));
  draw(ctx, 'monitor-front', m.x, m.y);
  if (avatar?.agent.state === 'falhou' && avatar.phase === 'sentado') {
    const s = iso(desk.x + 1.25, desk.y + 0.4, 12);
    draw(ctx, 'smoke', s.x, s.y, Math.floor(now / 200));
  }
}

function drawChair(index: number): void {
  const chair = chairOf(index);
  const sessionId = slots[index];
  const avatar = sessionId ? avatars.get(sessionId) : undefined;
  const seated = avatar?.phase === 'sentado' && avatar.path.length === 0;
  let frame = 0;
  if (seated && avatar.agent.state === 'ocioso' && !sleeping(avatar))
    frame = Math.floor(now / 900 + avatar.seed) % 2 ? 1 : 2;
  if (!seated && avatar?.phase === 'comemorando') frame = 3;
  const p = iso(chair.x - 0.25, chair.y - 0.25);
  draw(ctx, 'chair', p.x, p.y, frame);
}

/** Animação, quadro, linha e deslocamento da cabeça de cada pose. */
interface Look {
  anim: string;
  frame: number;
  row: number;
  flip: boolean;
  z: number;
  headDy: number;
  /** Quadro do fone do maestro: frente, costas, direita, esquerda. */
  head: number;
  emote?: { id: string; frame: number };
}

const HEAD_DY: Record<string, readonly number[]> = {
  'agent-walk': [0, -1, 0, -1],
  'agent-celebrate': [0, -3, -5, -2],
  'agent-deliver': [0, -1],
  'agent-sit-typing': [0, 0, 1],
  'agent-sit-paused': [1, 1],
  'agent-sit-sleep': [4, 3],
  'agent-sit-scratch': [0, 1],
  'agent-sit-stretch': [1, -1, -1, 0],
  'agent-sofa-chat': [1, 1],
  'agent-drink-water': [0, 0, -1],
};

const STRETCH_EVERY = 16_000;
const STRETCH_FOR = 1_800;

/** Quem está no outro lugar do bebedouro, já parado lá. */
function coolerPartner(avatar: Avatar): Avatar | undefined {
  for (const a of avatars.values()) {
    if (a === avatar || a.phase !== 'pausa' || a.path.length > 0) continue;
    if (a.spot?.kind === 'bebedouro') return a;
  }
  return undefined;
}

function lookOf(avatar: Avatar): Look {
  const walking = avatar.path.length > 0;
  const state = avatar.agent.state;
  const tick = (ms: number, offset = 0) => Math.floor((now + offset) / ms);
  const base = { flip: false, z: 0, row: 0 };
  let result: Omit<Look, 'headDy' | 'head'> & { head?: number };
  if (walking) {
    const row = avatar.facing;
    result = {
      ...base,
      anim: 'agent-walk',
      frame: Math.floor(avatar.walked * 5) % 4,
      row,
      head: row < 2 ? 0 : 1,
    };
    if (avatar.phase === 'indo-pausa' && avatar.spot) {
      const emote = {
        bebedouro: 'emote-water',
        cafe: 'emote-coffee',
        fliperama: 'emote-music',
        sinuca: 'emote-ok',
        conversa: 'emote-chat',
      }[avatar.spot.kind];
      if (now - avatar.arrivedAt < 4_000 || avatar.walked < 3)
        result.emote = { id: emote, frame: 0 };
    }
    if (avatar.phase === 'entregando') result.emote = { id: 'emote-idea', frame: 0 };
  } else if (
    avatar.phase === 'comemorando' ||
    (now < avatar.celebrateUntil && avatar.phase !== 'pausa')
  ) {
    result = {
      ...base,
      anim: 'agent-celebrate',
      frame: tick(160) % 4,
      head: 0,
      emote: { id: 'emote-confetti', frame: tick(200) % 3 },
    };
  } else if (avatar.phase === 'entregando') {
    result = { ...base, anim: 'agent-deliver', frame: tick(500) % 2, head: 0 };
  } else if (avatar.phase === 'pausa' && avatar.spot) {
    const spot = avatar.spot;
    const speed = spot.kind === 'fliperama' ? 180 : spot.kind === 'sinuca' ? 450 : 900;
    const frames = spriteDef(spot.anim).frames;
    result = {
      ...base,
      anim: spot.anim,
      frame: tick(speed, avatar.seed) % frames,
      z: spot.z,
      head: spot.view === 'front' ? 0 : 1,
    };
    if (spot.kind === 'conversa') {
      const turn = tick(1_800, avatar.seed) % 2 === 0;
      if (turn) result.emote = { id: 'emote-chat', frame: tick(300) % 2 };
      else result.frame = 0;
    }
    // Dois no bebedouro: viram um para o outro e batem papo, cada um na sua vez.
    if (spot.kind === 'bebedouro' && coolerPartner(avatar)) {
      const second = spot.id === 'bebedouro-1';
      const turn = tick(2_200) % 2 === (second ? 1 : 0);
      result.anim = 'agent-cooler-chat';
      result.head = 0;
      result.flip = second;
      result.frame = turn ? 1 + (tick(450) % 2) : 0;
      if (turn)
        result.emote = {
          id: tick(4_400, avatar.seed) % 3 ? 'emote-chat' : 'emote-idea',
          frame: tick(300) % 2,
        };
    }
  } else if (avatar.phase === 'sentado') {
    let anim = 'agent-sit-idle';
    let speed = 1_400;
    let emote: Look['emote'];
    if (sleeping(avatar)) {
      anim = 'agent-sit-sleep';
      emote = { id: 'emote-zzz', frame: tick(500) % 3 };
    } else if (state === 'executando') {
      anim = 'agent-sit-typing';
      speed = 110;
    } else if (state === 'pensando') {
      anim = 'agent-sit-thinking';
      emote = { id: 'emote-thinking', frame: tick(350) % 3 };
    } else if (state === 'aguardando-permissão' || state === 'aguardando-você') {
      anim = 'agent-sit-hand-up';
      speed = 400;
      emote = { id: 'emote-alert', frame: tick(400) % 2 };
    } else if (state === 'falhou') {
      anim = 'agent-sit-scratch';
      speed = 220;
      if (tick(1_200) % 2 === 0) emote = { id: 'emote-error', frame: 0 };
    } else if (state === 'pausado') {
      anim = 'agent-sit-paused';
    } else if (state === 'ocioso' && (now + avatar.seed * 7) % STRETCH_EVERY < STRETCH_FOR) {
      // Ocioso de vez em quando se espreguiça na cadeira.
      anim = 'agent-sit-stretch';
      speed = STRETCH_FOR / 4;
      const frame = Math.floor(((now + avatar.seed * 7) % STRETCH_EVERY) / speed);
      result = { ...base, anim, frame: Math.min(3, frame), head: 1 };
      const headDy = HEAD_DY[anim]?.[result.frame] ?? 0;
      return { ...result, head: 1, headDy };
    }
    const frames = spriteDef(anim).frames;
    result = { ...base, anim, frame: tick(speed, avatar.seed) % frames, head: 1 };
    if (emote) result.emote = emote;
  } else {
    result = { ...base, anim: 'agent-walk', frame: 0, row: 0, head: 0 };
  }
  const headDy = HEAD_DY[result.anim]?.[result.frame] ?? 0;
  return { ...result, head: result.head ?? 0, headDy };
}

function shadow(x: number, y: number, w = 6): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(Math.round(x - w), Math.round(y - 1), w * 2, 2);
  ctx.fillRect(Math.round(x - w + 2), Math.round(y - 2), w * 2 - 4, 1);
  ctx.fillRect(Math.round(x - w + 2), Math.round(y + 1), w * 2 - 4, 1);
}

const emotes: { x: number; y: number; id: string; frame: number }[] = [];

function drawAvatar(avatar: Avatar): void {
  const look = lookOf(avatar);
  const p = iso(avatar.pos.x, avatar.pos.y, look.z);
  const floor = iso(avatar.pos.x, avatar.pos.y);
  if (look.z === 0) shadow(floor.x, floor.y);
  const image = tinted(look.anim, avatar.look, avatar.swaps);
  draw(ctx, look.anim, p.x, p.y, look.frame, look.row, { image, flip: look.flip });
  if (isMaestro(avatar.agent)) {
    const head =
      look.anim === 'agent-walk'
        ? look.row === 1
          ? 3
          : look.row === 3
            ? 1
            : look.row === 2
              ? 1
              : 0
        : look.head;
    draw(ctx, 'agent-maestro-headset', p.x, p.y + look.headDy, head, 0, { flip: look.flip });
  }
  if (look.emote) emotes.push({ x: p.x + 5, y: p.y - 40 + look.headDy, ...look.emote });
}

function drawBarista(): void {
  const at = { x: 4.0, y: 0.72 };
  const serving = [...avatars.values()].some(
    (a) => a.spot?.kind === 'cafe' && a.phase === 'pausa' && now - a.arrivedAt < 3_000,
  );
  const frame = serving ? 2 + (Math.floor(now / 500) % 2) : Math.floor(now / 700) % 2;
  const p = iso(at.x, at.y);
  draw(ctx, 'npc-barista', p.x, p.y, frame);
}

function drawCat(): void {
  if (cat.mode === 'colo') {
    // Enrolado no colo: aparece pelo lado de fora da mesa de quem dorme, que está de costas.
    const p = iso(cat.pos.x, cat.pos.y, 13);
    draw(ctx, 'cat', p.x - 9, p.y, Math.floor(now / 2_500) % 4 === 0 ? 4 : 3, 0, { flip: true });
    return;
  }
  const p = iso(cat.pos.x, cat.pos.y);
  let frame = 3;
  if (cat.mode === 'andando') frame = [0, 1, 2, 1][Math.floor(cat.walked * 8) % 4] ?? 0;
  else if (cat.mode === 'dormindo') frame = 4;
  shadow(p.x, p.y, 4);
  draw(ctx, 'cat', p.x, p.y, frame, 0, { flip: cat.flip });
  if (cat.mode === 'dormindo')
    emotes.push({ x: p.x + 2, y: p.y - 14, id: 'emote-zzz', frame: Math.floor(now / 600) % 3 });
}

function scene(): Drawable[] {
  const f = front();
  const items: Drawable[] = [];
  const barBusy = [...avatars.values()].some((a) => a.spot?.kind === 'cafe' && a.phase === 'pausa');
  const drinking = [...avatars.values()].some(
    (a) => a.spot?.kind === 'bebedouro' && a.phase === 'pausa',
  );
  items.push(
    prop('plant-tall', 0.15, 0.15),
    prop('water-cooler', 1.0, 0.2, undefined, Math.floor(now / (drinking ? 150 : 600))),
    prop('bar-shelf', 2.9, 0.05, 3.0),
    { depth: 4.0, draw: drawBarista },
    prop('bar-counter', 2.9, 1.15, 4.6),
    prop('espresso', 5.5, 1.25, 4.7, barBusy && Math.floor(now / 300) % 2 ? 1 : 0, 23),
    {
      depth: 4.75,
      draw: () => {
        const s = iso(5.75, 1.45, 41);
        draw(ctx, 'steam', s.x, s.y, Math.floor(now / 250), 0, { alpha: 0.5 });
      },
    },
    ...[3.3, 4.4, 5.5].map((x) => prop('bar-stool', x, 2.15)),
    prop('arcade', 13.0, 0.25, undefined, Math.floor(now / 250)),
    { depth: 13.76, draw: drawArcadeScore },
    prop('jukebox', 14.3, 0.25, undefined, Math.floor(now / 300)),
    prop('plant-small', 15.3, 0.35),
    prop('floor-lamp', 0.3, f + 0.3),
    prop('sofa', 1.6, f + 0.4, 2.0 + f),
    prop('coffee-table', 3.75, f + 0.5),
    prop('plant-small', 4.85, f + 0.55),
    prop('pool-table', 9.0, f + 0.45),
    {
      depth: 9.0 + 1.1 + f + 0.45 + 0.6 + 0.05,
      draw: () => {
        balls.forEach((b, i) => {
          const p = iso(9.0 + 0.12 + b.x, f + 0.45 + 0.12 + b.y, 12);
          draw(ctx, 'pool-balls', p.x, p.y, i);
        });
      },
    },
    prop('plant-tall', 15.2, f + 0.4),
  );
  slots.forEach((_sessionId, index) => {
    const desk = deskOf(index);
    const chair = chairOf(index);
    items.push({
      depth: desk.x + DESK_W / 2 + desk.y + DESK_D / 2,
      draw: () => {
        drawDesk(index);
      },
    });
    items.push({
      depth: chair.x + chair.y - 0.02,
      draw: () => {
        drawChair(index);
      },
    });
  });
  for (const avatar of avatars.values()) {
    items.push({
      depth: avatar.pos.x + avatar.pos.y + (avatar.phase === 'sentado' ? 0.01 : 0),
      draw: () => {
        drawAvatar(avatar);
      },
    });
  }
  items.push({ depth: cat.pos.x + cat.pos.y, draw: drawCat });
  return items;
}

// --- Luz -------------------------------------------------------------------

let lightCanvas: HTMLCanvasElement | undefined;

/** Elipse em três faixas somadas: luz em degraus, no jeito de pixel art. */
function glow(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
): void {
  g.fillStyle = color;
  for (let ring = 0; ring < 3; ring++) {
    const k = 1 - ring * 0.3;
    const h = Math.max(1, Math.round(ry * k));
    for (let dy = -h; dy <= h; dy++) {
      const half = Math.round(rx * k * Math.sqrt(Math.max(0, 1 - (dy * dy) / (h * h))));
      if (half > 0) g.fillRect(Math.round(x - half), Math.round(y + dy), half * 2, 1);
    }
  }
}

function floorPatch(g: CanvasRenderingContext2D, points: Point[], color: string, alpha = 1): void {
  g.beginPath();
  points.forEach((p, i) => {
    if (i === 0) g.moveTo(Math.round(p.x), Math.round(p.y));
    else g.lineTo(Math.round(p.x), Math.round(p.y));
  });
  g.closePath();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.fill();
  g.globalAlpha = 1;
}

function beam(wy: number): Point[] {
  return [iso(0.1, wy + 0.2), iso(2.6, wy + 0.9), iso(2.6, wy + 2.7), iso(0.1, wy + 2.0)];
}

/** Sol entrando pelas janelas, no piso, antes dos móveis. */
function sunlight(): void {
  const hr = hour();
  const day = daylight(hr);
  if (day <= 0.2) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const wy of windowsY)
    floorPatch(ctx, beam(wy), lerpColor('#2e2610', '#4a2a10', golden(hr)), day);
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Luz da sala por mapa de luz: um fundo com a cor do ambiente (azul à
 * noite, branco de dia) mais as luzes somadas, multiplicado sobre a cena.
 * As luzes clareiam tudo em volta delas, inclusive os agentes.
 */
function lighting(): void {
  const hr = hour();
  const day = daylight(hr);
  const gold = golden(hr);
  const dark = 1 - day;
  if (dark < 0.02 && gold < 0.02) return;
  if (lightCanvas?.width !== artW || lightCanvas.height !== artH)
    lightCanvas = newCanvas(artW, artH);
  const g = context(lightCanvas);
  g.globalCompositeOperation = 'source-over';
  let ambient = lerpColor('#ffffff', '#2c3466', dark * 0.95);
  ambient = lerpColor(ambient, '#ffb27a', gold * 0.4);
  g.fillStyle = ambient;
  g.fillRect(0, 0, artW, artH);
  if (dark > 0.02) {
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = Math.min(1, dark * 1.2);
    const f = front();
    // Luar no chão.
    for (const wy of windowsY) floorPatch(g, beam(wy), '#141c3c');
    // Monitores ligados: a tela fica clara e o azul cai no agente e no chão.
    slots.forEach((sessionId, index) => {
      const avatar = sessionId ? avatars.get(sessionId) : undefined;
      if (!avatar || avatar.phase === 'saindo') return;
      const desk = deskOf(index);
      const screen = iso(desk.x + 0.62, desk.y + 0.22, 30);
      glow(g, screen.x, screen.y, 13, 11, '#4a6a90');
      const spill = iso(desk.x + 0.8, desk.y + 1.2, 10);
      glow(g, spill.x, spill.y, 26, 16, '#16243a');
    });
    // Faixa de neon das paredes.
    const n1 = iso(0, 0, 58.5);
    const n2 = iso(ROOM_W, 0, 58.5);
    const n3 = iso(0, roomH, 58.5);
    g.lineWidth = 9;
    g.strokeStyle = '#0a2a33';
    for (const [a, b] of [
      [n1, n2],
      [n1, n3],
    ] as const) {
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    g.lineWidth = 3;
    g.strokeStyle = '#8fd8e6';
    for (const [a, b] of [
      [n1, n2],
      [n1, n3],
    ] as const) {
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    // Luminária do sofá.
    const bulb = iso(0.47, f + 0.47, 42);
    glow(g, bulb.x, bulb.y, 9, 7, '#a08a50');
    const pool = iso(0.9, f + 0.8, 4);
    glow(g, pool.x, pool.y, 52, 28, '#2a2010');
    // Bar, cardápio, letreiro e placar.
    const bar = iso(4.6, 1.3, 20);
    glow(g, bar.x, bar.y, 52, 22, '#2a2010');
    const sign = iso(8.25, 0, 44);
    glow(g, sign.x, sign.y, 16, 14, '#1a5060');
    const board = iso(11.4, 0, 32);
    glow(g, board.x, board.y, 28, 22, '#3a4a5a');
    if (limits.size > 0) {
      const clock = iso(9.1, 0, 56);
      glow(g, clock.x, clock.y, 9, 9, '#802020');
    }
    // Fliperama, jukebox e máquina de café.
    const arcadeScreen = iso(13.4, 0.85, 32);
    glow(g, arcadeScreen.x, arcadeScreen.y, 10, 9, '#a07090');
    const arcadeScore = iso(13.4, 0.55, 58);
    glow(g, arcadeScore.x, arcadeScore.y, 14, 9, '#605030');
    const arcadeFloor = iso(13.5, 1.4, 0);
    glow(
      g,
      arcadeFloor.x,
      arcadeFloor.y,
      24,
      12,
      Math.floor(now / 250) % 2 ? '#301828' : '#102830',
    );
    const juke = iso(14.7, 0.75, 18);
    glow(g, juke.x, juke.y, 16, 14, '#4a3010');
    g.globalAlpha = 1;
  }
  // Só onde há cena; o fundo da página fica como está.
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(buffer, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

// --- Quadro ----------------------------------------------------------------

function layout(): void {
  const width = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  const height = Math.max(1, Math.round(canvas.clientHeight * (window.devicePixelRatio || 1)));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const w = ((ROOM_W + roomH) * TW) / 2 + 24;
  const h = ((ROOM_W + roomH) * TH) / 2 + WALL_H + 40;
  if (w !== artW || h !== artH) {
    artW = w;
    artH = h;
    buffer = newCanvas(artW, artH);
    ctx = context(buffer);
  }
  originX = (roomH * TW) / 2 + 12;
  originY = WALL_H + 28;
  const s = scaleFor(zoom, width, height);
  const ww = artW * s;
  const hh = artH * s;
  // Com zoom, dá para arrastar só até a borda da sala.
  const maxX = Math.max(0, (ww - width) / 2);
  const maxY = Math.max(0, (hh - height) / 2);
  pan = { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) };
  blit = { x: Math.round((width - ww) / 2 + pan.x), y: Math.round((height - hh) / 2 + pan.y), s };
}

let zoom = 1;
let pan = { x: 0, y: 0 };
const MAX_ZOOM = 4;

/**
 * Escala da sala no painel. Sem zoom, cabe inteira e usa escala inteira
 * quando dá (pixels todos iguais); com zoom, segue o zoom.
 */
function scaleFor(z: number, width = canvas.width, height = canvas.height): number {
  const fit = Math.min(width / artW, height / artH);
  if (z === 1 && fit >= 2) return Math.floor(fit);
  return fit * z;
}

/** Muda o zoom mantendo parado o ponto (x, y) do canvas, em pixels do aparelho. */
function zoomAt(next: number, x: number, y: number): void {
  const z = Math.max(1, Math.min(MAX_ZOOM, next));
  const before = blit.s;
  const ax = (x - blit.x) / before;
  const ay = (y - blit.y) / before;
  const s = scaleFor(z);
  zoom = z;
  pan =
    z === 1
      ? { x: 0, y: 0 }
      : {
          x: x - ax * s - (canvas.width - artW * s) / 2,
          y: y - ay * s - (canvas.height - artH * s) / 2,
        };
  layout();
  if (!frame) render();
}

let upscaled: HTMLCanvasElement | undefined;

/** Amplia o quadro de 1x: direto em escala inteira; senão, sobe para o inteiro de cima e desce suave. */
function present(): void {
  const { x, y, s } = blit;
  if (Number.isInteger(s) || s < 1) {
    screenCtx.imageSmoothingEnabled = false;
    screenCtx.drawImage(buffer, x, y, artW * s, artH * s);
    return;
  }
  const k = Math.ceil(s);
  if (upscaled?.width !== artW * k || upscaled.height !== artH * k)
    upscaled = newCanvas(artW * k, artH * k);
  const up = context(upscaled);
  up.imageSmoothingEnabled = false;
  up.clearRect(0, 0, upscaled.width, upscaled.height);
  up.drawImage(buffer, 0, 0, artW * k, artH * k);
  screenCtx.imageSmoothingEnabled = true;
  screenCtx.imageSmoothingQuality = 'high';
  screenCtx.drawImage(upscaled, x, y, artW * s, artH * s);
}

function render(): void {
  layout();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, artW, artH);
  drawStatic();
  sunlight();
  drawWallDecor();
  const f = front();
  const rug = iso(0.8, f + 0.1);
  draw(ctx, 'rug', rug.x, rug.y);
  emotes.length = 0;
  const items = scene();
  items.sort((a, b) => a.depth - b.depth);
  for (const item of items) item.draw();
  lighting();
  for (const e of emotes) draw(ctx, e.id, e.x, e.y, e.frame);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = C.out;
  ctx.fillRect(0, 0, artW, artH);
  ctx.globalCompositeOperation = 'source-over';
  if (offline) {
    ctx.fillStyle = 'rgba(10, 8, 16, 0.6)';
    ctx.fillRect(0, 0, artW, artH);
  }
  screenCtx.setTransform(1, 0, 0, 1, 0, 0);
  screenCtx.imageSmoothingEnabled = false;
  screenCtx.fillStyle = C.out;
  screenCtx.fillRect(0, 0, canvas.width, canvas.height);
  present();
}

// --- Laço ------------------------------------------------------------------

let last = 0;
let frame = 0;
let accumulated = 0;

function loop(time: number): void {
  frame = requestAnimationFrame(loop);
  const dt = Math.min(100, time - last);
  last = time;
  accumulated += dt;
  if (accumulated < 1000 / FPS) return;
  now += accumulated;
  step(accumulated);
  accumulated = 0;
  render();
}

function start(): void {
  if (frame) return;
  last = performance.now();
  frame = requestAnimationFrame(loop);
}

function stop(): void {
  cancelAnimationFrame(frame);
  frame = 0;
}

// --- Interação -------------------------------------------------------------

/** Avatar ou PC sob o ponteiro, de quem está mais à frente para trás. */
function hit(event: MouseEvent): string | undefined {
  const rectangle = canvas.getBoundingClientRect();
  const ratio = canvas.width / Math.max(1, rectangle.width);
  const px0 = ((event.clientX - rectangle.left) * ratio - blit.x) / blit.s;
  const py0 = ((event.clientY - rectangle.top) * ratio - blit.y) / blit.s;
  const candidates: { id: string; depth: number }[] = [];
  for (const avatar of avatars.values()) {
    const p = iso(avatar.pos.x, avatar.pos.y);
    if (px0 >= p.x - 9 && px0 <= p.x + 9 && py0 >= p.y - 40 && py0 <= p.y) {
      candidates.push({ id: avatar.agent.sessionId, depth: avatar.pos.x + avatar.pos.y + 1 });
    }
  }
  slots.forEach((sessionId, index) => {
    if (!sessionId) return;
    const desk = deskOf(index);
    const top = iso(desk.x + 0.8, desk.y + 0.3, 34);
    const bottom = iso(desk.x + 0.8, desk.y + 0.7);
    if (Math.abs(px0 - top.x) <= 16 && py0 >= top.y - 4 && py0 <= bottom.y) {
      candidates.push({ id: sessionId, depth: desk.x + desk.y });
    }
  });
  candidates.sort((a, b) => b.depth - a.depth);
  return candidates[0]?.id;
}

// Getters: o idioma é escolhido depois do carregamento do módulo (l10n.t não vai no topo).
export const STATE_LABEL: Record<string, string> = {
  get preparando() {
    return l10n.t('arriving');
  },
  get ocioso() {
    return l10n.t('idle');
  },
  get pensando() {
    return l10n.t('thinking');
  },
  get executando() {
    return l10n.t('working');
  },
  get 'aguardando-permissão'() {
    return l10n.t('asking permission');
  },
  get 'aguardando-você'() {
    return l10n.t('waiting for you');
  },
  get pausado() {
    return l10n.t('paused');
  },
  get concluído() {
    return l10n.t('on a break');
  },
  get falhou() {
    return l10n.t('failed');
  },
  get parado() {
    return l10n.t('stopped');
  },
};

// --- API -------------------------------------------------------------------

/** Um agente na sala, para a faixa de telas de quem hospeda. */
export interface CafeSeat {
  readonly agent: CafeAgent;
  readonly thumb?: AgentThumbnailEventData;
}

export interface CafeRoom {
  applyState(state: CafeState): void;
  onEvent(event: FaklEvent): void;
  /** Leva um agente ocioso a uma atividade escolhida pelo usuário. */
  setActivity(sessionId: string, kind: CafeActivity, durationMs: number): boolean;
  setOffline(value: boolean): void;
  readonly offline: boolean;
  /** Agentes na ordem dos PCs. */
  seats(): CafeSeat[];
  /** Para o desenho; `resume` volta a desenhar. */
  pause(): void;
  resume(): void;
  /** Fixa a hora do dia (0 a 24) para a luz e a janela; sem valor, segue o relógio. */
  setHour(value?: number): void;
}

/** Monta a sala num canvas; uma por página. */
export function mountCafe(roomOptions: CafeRoomOptions): CafeRoom {
  options = roomOptions;
  canvas = roomOptions.canvas;
  const context2d = canvas.getContext('2d');
  if (!context2d) throw new Error(l10n.t('Canvas 2D unavailable.'));
  screenCtx = context2d;
  register([...sceneSprites, ...agentSprites, ...uiSprites]);
  layout();
  if (roomOptions.assets) {
    void loadAssets(roomOptions.assets.base, roomOptions.assets.files).catch(() => 0);
  }
  canvas.style.touchAction = 'none';
  // Zoom com a roda ou com pinça, arrastar para andar, duplo clique volta ao todo.
  const ratio = () => canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  const local = (event: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: (event.clientX - r.left) * ratio(), y: (event.clientY - r.top) * ratio() };
  };
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const p = local(event);
      zoomAt(zoom * Math.exp(-event.deltaY * 0.0015), p.x, p.y);
    },
    { passive: false },
  );
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false;
  let pinch = 0;
  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, local(event));
    dragged = false;
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const p = local(event);
    pointers.set(event.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) zoomAt((zoom * distance) / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = distance;
      dragged = true;
      return;
    }
    if (!dragged && Math.hypot(p.x - last.x, p.y - last.y) < 4 * ratio()) {
      pointers.set(event.pointerId, last);
      return;
    }
    dragged = true;
    pan = { x: pan.x + p.x - last.x, y: pan.y + p.y - last.y };
    layout();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = 0;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', () => {
    zoom = 1;
    pan = { x: 0, y: 0 };
  });
  canvas.addEventListener('click', (event) => {
    if (dragged) return;
    const sessionId = hit(event);
    if (sessionId) options.onOpen(sessionId);
  });

  canvas.addEventListener('mousemove', (event) => {
    const sessionId = hit(event);
    const avatar = sessionId ? avatars.get(sessionId) : undefined;
    canvas.style.cursor = sessionId ? 'pointer' : 'default';
    canvas.title = avatar
      ? `${avatar.agent.nome} · ${STATE_LABEL[avatar.agent.state] ?? avatar.agent.state}${avatar.thumb ? ` · ${avatar.thumb.titulo}` : ''}`
      : '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  start();
  return {
    applyState,
    onEvent,
    setActivity,
    setOffline: (value) => {
      offline = value;
      changed();
    },
    get offline() {
      return offline;
    },
    seats: () =>
      [...avatars.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((a) => ({ agent: a.agent, ...(a.thumb ? { thumb: a.thumb } : {}) })),
    pause: stop,
    resume: start,
    setHour: (value) => {
      hourOverride = value;
    },
  };
}
