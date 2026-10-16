import { l10n } from '@fakl/i18n';

import { h } from './dom.js';
import { petStatus, type PetRing } from './model.js';
import type { Overlay } from './store.js';

/**
 * A forma pet: o prompt `>_` da marca, vivo. O anel diz o estado, o cursor
 * pisca enquanto alguém trabalha e vira `?` quando esperam você ou `!` quando
 * algo falhou. O anel é a alça de arrastar (`-webkit-app-region: drag`); o
 * rosto é o botão: clique abre o painel, duplo clique traz a IDE.
 */

const GLYPH: Record<PetRing, string> = {
  quieto: '_',
  trabalhando: '_',
  espera: '?',
  falha: '!',
};

/** Espera um segundo clique antes de abrir o painel, para o duplo clique valer. */
const DOUBLE_CLICK_MS = 260;

export function petView(overlay: Overlay): {
  element: HTMLElement;
  update(): void;
  /** Há balão na tela: a janela precisa da forma `balao`. */
  hasBubble(): boolean;
} {
  const cursor = h('span', { class: 'pet-cursor' }, '_');
  const glyph = h('span', { class: 'pet-glifo', 'aria-hidden': 'true' }, '>', cursor);
  const badge = h('span', { class: 'pet-selo', 'aria-hidden': 'true' });
  const bubble = h('div', { class: 'balao', role: 'status', 'aria-live': 'polite' });

  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  const face = h(
    'button',
    {
      type: 'button',
      class: 'pet-rosto',
      onclick: () => {
        if (clickTimer) return;
        clickTimer = setTimeout(() => {
          clickTimer = undefined;
          overlay.open();
        }, DOUBLE_CLICK_MS);
      },
      ondblclick: () => {
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = undefined;
        overlay.reveal();
      },
      onkeydown: (event: Event) => {
        // Pelo teclado não há duplo clique: Shift+Enter traz a IDE.
        const key = event as KeyboardEvent;
        if (key.key === 'Enter' && key.shiftKey) {
          key.preventDefault();
          overlay.reveal();
        }
      },
    },
    glyph,
  );

  const element = h(
    'div',
    { class: 'pet' },
    h(
      'div',
      { class: 'pet-corpo' },
      h('span', { class: 'pet-anel', 'aria-hidden': 'true' }),
      face,
      badge,
    ),
    bubble,
  );

  // O principal diz para que lado o balão abre (o do centro da tela); o pet vai para o outro canto.
  element.dataset.lado = 'esquerda';
  overlay.bridge.onSide((side) => {
    element.dataset.lado = side;
  });

  const update = (): void => {
    const status = petStatus(overlay.snapshot());
    element.dataset.anel = status.ring;
    element.dataset.conexao = overlay.connection;
    cursor.textContent = GLYPH[status.ring];
    badge.textContent = status.count > 0 ? String(Math.min(status.count, 99)) : '';
    badge.hidden = status.count === 0;
    const offline = overlay.connection === 'offline';
    face.setAttribute(
      'aria-label',
      offline
        ? l10n.t(
            'No connection to the Core. {0}. Open the agents panel; Shift+Enter opens the IDE.',
            status.label,
          )
        : l10n.t('{0}. Open the agents panel; Shift+Enter opens the IDE.', status.label),
    );
    face.title = offline ? l10n.t('No connection to the Core. {0}', status.label) : status.label;
    const text = overlay.bubble && overlay.bubble.until > Date.now() ? overlay.bubble.text : '';
    if (bubble.textContent !== text) bubble.textContent = text;
    bubble.hidden = text === '';
  };
  update();
  return { element, update, hasBubble: () => !bubble.hidden };
}
