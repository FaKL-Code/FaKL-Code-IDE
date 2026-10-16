import { mountCafe, type CafeRoom } from '@fakl/cafe';
import { l10n } from '@fakl/i18n';
import type { CafeState } from '@fakl/protocol';

import { app } from '../app.js';
import { h } from '../dom.js';
import { type View } from './parts.js';

/** A sala do café (RF-302): o mesmo canvas entre visitas, para não perder a animação. */
const canvas = document.createElement('canvas');
canvas.className = 'cafe';
let room: CafeRoom | undefined;
let open = false;
/** Muda a cada fechamento: um `cafe.open` que volta depois de fechar não reabre a sala. */
let generation = 0;

async function openRoom(): Promise<void> {
  const session = app.session;
  room ??= mountCafe({
    canvas,
    onOpen: (sessionId) => {
      app.go({ name: 'conversa', sessionId });
    },
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
    room.applyState(cafe);
  } catch {
    open = false;
    room.setOffline(true);
  }
}

async function closeRoom(): Promise<void> {
  generation++;
  room?.pause();
  if (!open) return;
  open = false;
  await app.session?.request('cafe.close').catch(() => undefined);
}

export function cafeView(): View {
  canvas.setAttribute('aria-label', l10n.t('Cyber café room with the agents'));
  const el = h(
    'div',
    { class: 'tela sala' },
    canvas,
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
