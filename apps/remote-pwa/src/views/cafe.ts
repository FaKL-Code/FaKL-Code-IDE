import {
  Announcer,
  describeRoom,
  describeSeat,
  mountCafe,
  type CafeRoom,
  type SeatInfo,
} from '@fakl/cafe';
import { l10n } from '@fakl/i18n';
import type { CafeState } from '@fakl/protocol';

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
let announceTimer: number | undefined;
/** Só depois do primeiro retrato há o que comparar. */
let loaded = false;
let presentSignature = '';
let room: CafeRoom | undefined;
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
  const wait = announcer.waitMs(Date.now());
  if (wait === undefined) return;
  announceTimer = window.setTimeout(() => {
    announceTimer = undefined;
    const text = announcer.take(Date.now());
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
        .then((cafe) => room?.applyState(cafe))
        .catch(() => undefined);
    },
  });
  if (!session) {
    room.setOffline(true);
    return;
  }
  const mine = generation;
  room.resume();
  // Conta como aberta desde já: um fechamento no meio manda o `cafe.close`
  // depois do `cafe.open`, na mesma ordem do canal.
  open = true;
  try {
    const cafe = await session.request<CafeState>('cafe.open');
    if (mine !== generation) return;
    room.setOffline(false);
    loaded = false;
    announcer = new Announcer({ minIntervalMs: 5_000 });
    room.applyState(cafe);
    // O retrato inicial é o ponto de partida; só o que muda depois é anunciado.
    loaded = true;
    renderAccessible();
  } catch {
    open = false;
    room.setOffline(true);
  }
}

async function closeRoom(): Promise<void> {
  generation++;
  loaded = false;
  room?.pause();
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
    present,
    live,
    h('p', { class: 'meta' }, l10n.t('Tap an agent to open its conversation.')),
  );
  const stop = app.onEvent((event) => {
    if (open) room?.onEvent(event);
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
