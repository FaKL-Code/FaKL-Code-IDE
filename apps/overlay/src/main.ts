import { l10n, useLocale } from '@fakl/i18n';

import type { OverlayShape } from './bridge.js';
import { h } from './dom.js';
import { panelView } from './panel.js';
import { petView } from './pet.js';
import { Overlay } from './store.js';

/**
 * Modo minimizado (ADR 0032): a página do overlay. A janela é transparente;
 * o pet e o painel desenham as próprias formas. Só uma forma aparece por vez,
 * e quem decide o tamanho da janela é o processo principal (`setMode`).
 */

// No Electron da IDE, o navigator.language segue o idioma da IDE; o Core ainda
// não manda o idioma da IDE para o overlay.
document.documentElement.lang = useLocale(navigator.language) === 'pt-br' ? 'pt-BR' : 'en';
document.title = l10n.t('FaKL-Code: agents');

const root = document.getElementById('app') ?? document.body;
const bridge = window.faklOverlay;

if (!bridge) {
  root.replaceChildren(
    h(
      'p',
      { class: 'sem-ponte' },
      l10n.t(
        'This page only opens from FaKL-Code minimized mode: the bridge to the IDE is missing.',
      ),
    ),
  );
} else {
  const overlay = new Overlay(bridge);
  const pet = petView(overlay);
  const panel = panelView(overlay);
  root.replaceChildren(pet.element, panel.element);

  // Com o balão, a janela do pet se alarga para o lado do centro da tela (forma `balao`) e volta
  // a 72x72 quando ele some. Na área vazia, os cliques passam para o programa de baixo.
  let shape: OverlayShape = overlay.mode;
  let through = false;
  const syncShape = (): void => {
    const next: OverlayShape =
      overlay.mode === 'painel' ? 'painel' : pet.hasBubble() ? 'balao' : 'pet';
    if (next === shape) return;
    shape = next;
    // O principal volta a segurar os cliques a cada troca de forma.
    through = false;
    bridge.setMode(next);
  };
  document.addEventListener('mousemove', (event) => {
    if (shape !== 'balao') return;
    const target = event.target instanceof Element ? event.target : null;
    const empty = !target?.closest('.pet-corpo, .balao');
    if (empty === through) return;
    through = empty;
    bridge.setClickThrough(empty);
  });

  const render = (): void => {
    root.dataset.forma = overlay.mode;
    pet.element.hidden = overlay.mode !== 'pet';
    panel.element.hidden = overlay.mode !== 'painel';
    pet.update();
    panel.update();
    syncShape();
  };
  overlay.onChange(render);
  render();

  let lastMode = overlay.mode;
  overlay.onChange(() => {
    if (overlay.mode === lastMode) return;
    lastMode = overlay.mode;
    // O foco acompanha a forma: o painel abre na tela atual, o pet volta ao rosto.
    if (overlay.mode === 'pet') pet.element.querySelector<HTMLElement>('.pet-rosto')?.focus();
    else panel.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.mode === 'painel') {
      event.preventDefault();
      overlay.collapse();
    }
  });

  // Clicar fora (outra janela ganha o foco) recolhe, a não ser que o painel esteja fixado.
  window.addEventListener('blur', () => {
    if (overlay.mode === 'painel' && !overlay.prefs.fixado) overlay.collapse();
  });

  // "há 5 min" envelhece sozinho.
  setInterval(render, 30_000);
}
