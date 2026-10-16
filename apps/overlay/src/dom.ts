import { renderMarkdown } from '@fakl/conversa';

// ---------------------------------------------------------------- elementos

export type Child = Node | string | false | null | undefined;

type Props = Partial<Record<string, string | boolean | ((event: Event) => void)>>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, value);
  }
  append(element, children);
  return element;
}

/** Marca o lugar de um elemento dentro de um texto traduzido: `l10n.t('… {0} …', SLOT)`. */
export const SLOT = '\u0001';

/** Um texto traduzido com `SLOT` no lugar de `{0}`, e o elemento posto ali. */
export function withSlot(text: string, node: Child): Child[] {
  const [before = '', after = ''] = text.split(SLOT);
  return [before, node, after];
}

export function append(parent: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    parent.append(child);
  }
}

/**
 * Troca os filhos só se o resultado for outro: as listas se refazem a cada
 * evento e um clique em "Permitir" não pode cair num botão recém-trocado. O
 * foco volta para o elemento equivalente (mesmo `data-foco`) quando há troca.
 */
export function patch(parent: Element, ...children: Child[]): void {
  const next = document.createElement(parent.tagName);
  append(next, children);
  if (next.innerHTML === parent.innerHTML) return;
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLElement && parent.contains(active) ? active.dataset.foco : undefined;
  parent.replaceChildren(...next.childNodes);
  if (focusKey) {
    parent.querySelector<HTMLElement>(`[data-foco="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

/** Markdown das falas, já escapado pelo `@fakl/conversa`. */
export function markdown(text: string, className = 'md'): HTMLElement {
  const element = h('div', { class: className });
  element.innerHTML = renderMarkdown(text, { highlight: true });
  return element;
}

/** Uma linha com `código` e **negrito**, sem parágrafo em volta (títulos de permissão). */
export function inlineMarkdown(text: string): HTMLElement {
  const element = h('span', { class: 'md-linha' });
  element.innerHTML = renderMarkdown(text.replace(/\s*\n\s*/g, ' '))
    .replace(/^<p>/, '')
    .replace(/<\/p>$/, '');
  return element;
}

// ---------------------------------------------------------------- ícones

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ícones de traço em grade 24x24, da mesma família dos do celular e da Mesa. */
const ICONS = {
  mais: '<path d="M12 5v14M5 12h14"/>',
  recolher: '<path d="M6 12h12"/>',
  voltar: '<path d="M15 5l-7 7 7 7"/>',
  enviar: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  interromper:
    '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  retomar:
    '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" fill="currentColor" stroke="none"/>',
  parar:
    '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
  ide: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
  silencio: '<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 21h4M4 4l16 16"/>',
  fixar: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
  esconder:
    '<path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2M4 4l16 16"/>',
  sair: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  escudo: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/>',
  troca: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  pergunta:
    '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6v.4"/>',
  limite: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  tarefa: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGSVGElement {
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
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Botão só de ícone, com nome para leitor de tela e dica ao passar o mouse. */
export function iconButton(
  name: IconName,
  label: string,
  onclick: () => void,
  extra: Props = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'icone',
      'aria-label': label,
      title: label,
      onclick: (event: Event) => {
        event.stopPropagation();
        onclick();
      },
      ...extra,
    },
    icon(name),
  );
}

/** Anel pequeno de 0 a 1, como o de contexto dos agentes. */
export function miniRing(fraction: number, label: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const r = 6;
  const length = 2 * Math.PI * r;
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('class', fraction >= 0.85 ? 'anel-mini cheio' : 'anel-mini');
  const share = Math.min(1, Math.max(0, fraction));
  svg.innerHTML =
    `<title>${label}</title>` +
    `<circle cx="8" cy="8" r="${String(r)}" class="anel-trilho"/>` +
    `<circle cx="8" cy="8" r="${String(r)}" class="anel-valor" stroke-dasharray="${(share * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/>`;
  return svg;
}
