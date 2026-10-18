/**
 * Dicas do tour dentro das telas da FaKL: um ponto que pulsa no elemento e um
 * balão curto que a pessoa dispensa. O host manda as dicas ainda não vistas
 * (`fakl.dicas`); aqui só se desenha e se devolve o que a pessoa fez. Tudo é
 * montado por propriedades do elemento e `animate()`, sem folha de estilo nem
 * `style` inline, para caber na CSP das webviews.
 */

import type { FromTips, TipView, ToTips, TourSurface } from '../tour-protocol.js';

interface HostApi {
  postMessage(message: unknown): void;
}

const POLL_MS = 500;
/** Quanto tempo se espera o elemento aparecer antes de desistir da dica (ela volta na próxima abertura). */
const GIVE_UP_MS = 15_000;
const BUBBLE_WIDTH = 280;
const MARGIN = 8;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: Partial<CSSStyleDeclaration>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, css);
  return node;
}

function visible(target: Element | null): target is Element {
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Mostra uma dica e resolve quando ela é dispensada (`true`) ou o elemento nunca apareceu (`false`). */
function showTip(tip: TipView, labels: ToTips['rotulos'], host: HostApi): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    let layer: HTMLElement | undefined;
    let dot: HTMLElement;
    let bubble: HTMLElement;

    const finish = (shown: boolean): void => {
      clearInterval(timer);
      layer?.remove();
      resolve(shown);
    };

    const build = (): void => {
      layer = element('div', {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2147483000',
      });
      dot = element('div', {
        position: 'fixed',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: 'var(--vscode-focusBorder, #3794ff)',
        boxShadow: '0 0 0 2px var(--vscode-editor-background, #1e1e1e)',
      });
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        dot.animate(
          [
            { transform: 'scale(1)', opacity: 1 },
            { transform: 'scale(1.7)', opacity: 0.45 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 1600, iterations: Infinity },
        );
      }
      bubble = element('div', {
        position: 'fixed',
        width: `${BUBBLE_WIDTH}px`,
        boxSizing: 'border-box',
        padding: '10px 12px',
        pointerEvents: 'auto',
        background: 'var(--vscode-editorWidget-background, #252526)',
        color: 'var(--vscode-editorWidget-foreground, #cccccc)',
        border: '1px solid var(--vscode-focusBorder, #3794ff)',
        borderRadius: '6px',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
        font: 'var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif)',
        lineHeight: '1.4',
      });
      bubble.setAttribute('role', 'dialog');
      bubble.setAttribute('aria-label', tip.texto);
      const text = element('p', { margin: '0 0 8px' });
      text.textContent = tip.texto;
      const row = element('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
      const button = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
        const node = element('button', {
          cursor: 'pointer',
          padding: '3px 10px',
          borderRadius: '3px',
          border: primary ? 'none' : '1px solid var(--vscode-button-border, transparent)',
          background: primary
            ? 'var(--vscode-button-background, #0e639c)'
            : 'var(--vscode-button-secondaryBackground, #3a3d41)',
          color: primary
            ? 'var(--vscode-button-foreground, #ffffff)'
            : 'var(--vscode-button-secondaryForeground, #ffffff)',
          font: 'inherit',
        });
        node.type = 'button';
        node.textContent = label;
        node.addEventListener('click', onClick);
        return node;
      };
      row.append(
        button(labels.desligar, false, () => {
          const message: FromTips = { type: 'fakl.dicas.desligar' };
          host.postMessage(message);
          finish(true);
        }),
        button(labels.entendi, true, () => {
          const message: FromTips = { type: 'fakl.dicas.vista', id: tip.id };
          host.postMessage(message);
          finish(true);
        }),
      );
      bubble.append(text, row);
      layer.append(dot, bubble);
      document.body.append(layer);
    };

    /** Põe o ponto no canto do elemento e o balão abaixo dele (ou acima, se não couber). */
    const place = (target: Element): void => {
      const rect = target.getBoundingClientRect();
      const x = Math.min(Math.max(rect.right - 7, MARGIN), window.innerWidth - 22);
      const y = Math.min(Math.max(rect.top, MARGIN), window.innerHeight - 22);
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      const left = Math.min(
        Math.max(x - BUBBLE_WIDTH + 24, MARGIN),
        Math.max(window.innerWidth - BUBBLE_WIDTH - MARGIN, MARGIN),
      );
      const below = y + 24 + bubble.offsetHeight + MARGIN <= window.innerHeight;
      bubble.style.left = `${left}px`;
      bubble.style.top = below
        ? `${y + 24}px`
        : `${Math.max(y - bubble.offsetHeight - 10, MARGIN)}px`;
    };

    const timer = setInterval(() => {
      const target = document.querySelector(tip.alvo);
      if (!visible(target)) {
        if (layer) layer.hidden = true;
        if (!layer && Date.now() - started > GIVE_UP_MS) finish(false);
        return;
      }
      if (!layer) build();
      if (layer) layer.hidden = false;
      place(target);
    }, POLL_MS);
  });
}

/**
 * Liga as dicas da tela `surface`: avisa o host que a página está pronta e
 * mostra, uma de cada vez, as dicas que ele mandar.
 */
export function initCoach(host: HostApi, surface: TourSurface): void {
  let running = false;
  window.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
    if (event.data.type !== 'fakl.dicas' || running) return;
    const { dicas, rotulos } = event.data as ToTips;
    running = true;
    void (async () => {
      for (const tip of dicas) await showTip(tip, rotulos, host);
    })().finally(() => {
      running = false;
    });
  });
  const ready: FromTips = { type: 'fakl.dicas.pronto', superficie: surface };
  host.postMessage(ready);
}
