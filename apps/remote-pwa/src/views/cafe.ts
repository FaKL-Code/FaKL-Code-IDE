import {
  Announcer,
  AnnouncerGroup,
  describeKitchen,
  describeRoom,
  describeSeat,
  mountCafe,
  mountKitchen,
  renderKitchenCards,
  renderKitchenList,
  RunAnnouncer,
  type CafeRoom,
  type Kitchen,
  type SeatInfo,
} from '@fakl/cafe';
import { l10n } from '@fakl/i18n';
import type { CafeState, CiRun } from '@fakl/protocol';

import { app } from '../app.js';
import { h } from '../dom.js';
import { type View } from './parts.js';

/** A sala do café (RF-302): o mesmo canvas entre visitas, para não perder a animação. */
const canvas = document.createElement('canvas');
canvas.className = 'cafe';
/** Lista para leitor de tela e região de anúncios: o canvas sozinho não diz quem está na sala. */
const present = h('ul', { class: 'so-leitor' });
const live = h('div', { class: 'so-leitor', role: 'status', 'aria-live': 'polite' });
let announcer = new Announcer({ minIntervalMs: 5_000 });
/** Resultados do CI entram na mesma região de anúncios, agrupados com os dos agentes. */
let runAnnouncer = new RunAnnouncer({ minIntervalMs: 5_000 });
let speech = new AnnouncerGroup(announcer, runAnnouncer);
let announceTimer: number | undefined;
/** Só depois do primeiro retrato há o que comparar. */
let loaded = false;
let presentSignature = '';
let room: CafeRoom | undefined;
/** Cozinha do CI (ADR 0051): o celular só lê; clicar abre a execução no navegador. */
const kitchenCanvas = document.createElement('canvas');
kitchenCanvas.className = 'cozinha';
kitchenCanvas.hidden = true;
const kitchenList = h('ul', { class: 'so-leitor' });
const kitchenCards = h('div', { class: 'ci-faixa', role: 'list', hidden: true });
let kitchen: Kitchen | undefined;
let open = false;
/** Muda a cada fechamento: um `cafe.open` que volta depois de fechar não reabre a sala. */
let generation = 0;

function seatInfos(): SeatInfo[] {
  const limited = room?.limited();
  return (room?.seats() ?? []).map((seat) => ({
    id: seat.agent.sessionId,
    name: seat.agent.nome,
    state: seat.agent.state,
    limited: seat.agent.runId !== undefined && limited?.has(seat.agent.runId) === true,
    ...((seat.thumb?.titulo ?? seat.agent.papel)
      ? { detail: seat.thumb?.titulo ?? seat.agent.papel }
      : {}),
  }));
}

function scheduleAnnouncement(): void {
  if (announceTimer !== undefined) return;
  const wait = speech.waitMs(Date.now());
  if (wait === undefined) return;
  announceTimer = window.setTimeout(() => {
    announceTimer = undefined;
    const text = speech.take(Date.now());
    if (text) live.textContent = text;
    scheduleAnnouncement();
  }, wait);
}

/** Atualiza a lista escondida, o resumo do canvas e os anúncios. */
function renderAccessible(): void {
  const infos = seatInfos();
  canvas.setAttribute(
    'aria-label',
    `${l10n.t('Cyber café room with the agents')}. ${describeRoom(infos, room?.offline ?? true)}`,
  );
  const signature = infos.map((info) => `${info.id}|${describeSeat(info)}`).join('||');
  if (signature !== presentSignature) {
    presentSignature = signature;
    present.replaceChildren(
      ...infos.map((info) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              title: l10n.t('Open conversation with {0}', info.name),
              onclick: () => {
                app.go({ name: 'conversa', sessionId: info.id });
              },
            },
            describeSeat(info),
          ),
        ),
      ),
    );
  }
  if (loaded) {
    announcer.observe(infos);
    scheduleAnnouncement();
  }
}

/** O celular não abre o painel de Actions da IDE: leva ao GitHub, no navegador. */
function openRun(run: CiRun): void {
  if (run.url.startsWith('https://github.com/')) window.open(run.url, '_blank', 'noopener');
}

/** Mostra a cozinha só com repositórios acompanhados; lista, cartões e anúncios seguem a bancada. */
function renderKitchen(): void {
  const status = kitchen?.status;
  const runs = kitchen?.runs() ?? [];
  const visible = status !== undefined && status.repos.length > 0;
  kitchenCanvas.hidden = !visible;
  kitchenCanvas.setAttribute(
    'aria-label',
    [
      describeKitchen(status) || l10n.t('CI kitchen'),
      runs.length === 0 ? l10n.t('No runs yet.') : '',
    ]
      .filter(Boolean)
      .join('. '),
  );
  renderKitchenList(kitchenList, runs, { onOpen: openRun });
  renderKitchenCards(kitchenCards, runs, { onOpen: openRun });
  if (visible) {
    // A primeira leitura fixa o ponto de partida; só o que muda depois é anunciado.
    runAnnouncer.observe(runs);
    if (loaded) scheduleAnnouncement();
  }
}

function applyCafeState(cafe: CafeState): void {
  room?.applyState(cafe);
  kitchen?.apply(cafe.ci);
}

async function openRoom(): Promise<void> {
  const session = app.session;
  room ??= mountCafe({
    canvas,
    onOpen: (sessionId) => {
      app.go({ name: 'conversa', sessionId });
    },
    onChange: renderAccessible,
    onRefresh: () => {
      void app.session
        ?.request<CafeState>('cafe.state')
        .then((cafe) => {
          applyCafeState(cafe);
        })
        .catch(() => undefined);
    },
  });
  kitchen ??= mountKitchen({ canvas: kitchenCanvas, onOpen: openRun, onChange: renderKitchen });
  if (!session) {
    room.setOffline(true);
    kitchen.setOffline(true);
    return;
  }
  const mine = generation;
  room.resume();
  kitchen.resume();
  // Conta como aberta desde já: um fechamento no meio manda o `cafe.close`
  // depois do `cafe.open`, na mesma ordem do canal.
  open = true;
  try {
    const cafe = await session.request<CafeState>('cafe.open');
    if (mine !== generation) return;
    room.setOffline(false);
    kitchen.setOffline(false);
    loaded = false;
    announcer = new Announcer({ minIntervalMs: 5_000 });
    runAnnouncer = new RunAnnouncer({ minIntervalMs: 5_000 });
    speech = new AnnouncerGroup(announcer, runAnnouncer);
    applyCafeState(cafe);
    // O retrato inicial é o ponto de partida; só o que muda depois é anunciado.
    loaded = true;
    renderAccessible();
  } catch {
    open = false;
    room.setOffline(true);
    kitchen.setOffline(true);
  }
}

async function closeRoom(): Promise<void> {
  generation++;
  loaded = false;
  room?.pause();
  kitchen?.pause();
  if (!open) return;
  open = false;
  await app.session?.request('cafe.close').catch(() => undefined);
}

export function cafeView(): View {
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', l10n.t('Cyber café room with the agents'));
  const el = h(
    'div',
    { class: 'tela sala' },
    canvas,
    kitchenCanvas,
    kitchenCards,
    present,
    kitchenList,
    live,
    h('p', { class: 'meta' }, l10n.t('Tap an agent to open its conversation.')),
  );
  const stop = app.onEvent((event) => {
    if (!open) return;
    // Execuções do CI vão para a cozinha; o resto, para a sala.
    if (event.topic === 'ci.run') kitchen?.onRun(event.data as CiRun);
    else room?.onEvent(event);
  });
  let online = false;
  const update = (): void => {
    // Abre ao chegar a conexão ou a tela; com a tela apagada, o Core para de gerar miniaturas.
    const now = Boolean(app.session) && document.visibilityState === 'visible';
    if (now && !online) void openRoom();
    if (!now && online) void closeRoom();
    if (!app.session) room?.setOffline(true);
    online = now;
  };
  const onVisible = (): void => {
    update();
  };
  document.addEventListener('visibilitychange', onVisible);
  update();
  return {
    el,
    update,
    dispose: () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      void closeRoom();
    },
  };
}
