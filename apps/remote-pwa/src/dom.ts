import { renderMarkdown } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';

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

export function append(parent: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    parent.append(child);
  }
}

/**
 * Troca os filhos só se o resultado for outro. As listas se refazem a cada
 * evento; sem isto, um toque em "Permitir" podia cair num botão que acabou de
 * ser trocado por um igual.
 */
export function patch(parent: Element, ...children: Child[]): void {
  const next = document.createElement(parent.tagName);
  append(next, children);
  if (next.innerHTML === parent.innerHTML) return;
  parent.replaceChildren(...next.childNodes);
}

export function toast(text: string, tone: 'info' | 'erro' = 'info'): void {
  const element = h('div', { class: `toast ${tone}`, role: 'status' }, text);
  document.body.append(element);
  setTimeout(() => {
    element.classList.add('saindo');
    setTimeout(() => {
      element.remove();
    }, 300);
  }, 3_200);
}

// ---------------------------------------------------------------- ícones

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ícones de traço em grade 24x24, como os da Mesa e do chat da IDE. */
const ICONS = {
  agentes:
    '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="M19 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  tarefas: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  caixa:
    '<path d="M4 13l2.5-7.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  cafe: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 11h2a2 2 0 0 1 0 4h-2M8 3v3M12 3v3"/>',
  uso: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/>',
  ajustes:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  voltar: '<path d="M15 5l-7 7 7 7"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  enviar: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  pausar:
    '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  retomar:
    '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" fill="currentColor" stroke="none"/>',
  parar:
    '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
  menu: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  diff: '<path d="M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9v3a4 4 0 0 1-4 4H9"/>',
  copiar:
    '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  baixo: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  escudo: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/>',
  modelo:
    '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  pasta: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ramo: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>',
  arquivo:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  lapis: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  busca: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  globo:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  ideia:
    '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  chave:
    '<path d="M14.5 4a5.5 5.5 0 1 1-4.9 8L3 18.5V21h3v-2h2v-2h2l1.4-1.4A5.5 5.5 0 0 1 14.5 4z"/>',
  mover: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alerta: '<path d="M12 4l9 16H3zM12 10v4M12 17v.5"/>',
  sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  atualizar: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  microfone:
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 20): SVGSVGElement {
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
  // Os desenhos são constantes deste arquivo, nunca texto vindo de fora.
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Ícone da ferramenta pelo `kind` do ACP. */
export function toolIcon(kind: string | undefined): IconName {
  switch (kind) {
    case 'read':
      return 'arquivo';
    case 'edit':
      return 'lapis';
    case 'delete':
      return 'lixo';
    case 'move':
      return 'mover';
    case 'search':
      return 'busca';
    case 'execute':
      return 'terminal';
    case 'fetch':
      return 'globo';
    case 'think':
      return 'ideia';
    default:
      return 'chave';
  }
}

// ---------------------------------------------------------------- anéis

const RING = 2 * Math.PI * 15;

/**
 * Anel de 0 a 1 com o número no meio. Sem fração, um anel apagado de "sem
 * teto"; `label` troca o número do meio.
 */
export function ring(
  fraction: number | undefined,
  options: { size?: number; tone?: string; label?: string } = {},
): HTMLElement {
  const size = options.size ?? 44;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'circle');
  const arc = document.createElementNS(SVG_NS, 'circle');
  for (const circle of [track, arc]) {
    circle.setAttribute('cx', '18');
    circle.setAttribute('cy', '18');
    circle.setAttribute('r', '15');
  }
  track.setAttribute('class', 'trilho');
  arc.setAttribute('class', 'arco');
  const value = fraction ?? 0;
  arc.style.strokeDasharray = `${String(RING * value)} ${String(RING)}`;
  // Com zero, a ponta redonda do traço ainda desenharia um ponto.
  svg.append(track);
  if (value > 0) svg.append(arc);
  const tone =
    options.tone ??
    (fraction === undefined
      ? 'neutro'
      : fraction >= 1
        ? 'ruim'
        : fraction >= 0.8
          ? 'atencao'
          : 'ok');
  const label =
    options.label ?? (fraction === undefined ? '—' : `${String(Math.round(fraction * 100))}%`);
  const box = h(
    'span',
    { class: `anel ${tone}`, style: `--tam:${String(size)}px` },
    svg,
    h('span', { class: 'anel-valor' }, label),
  );
  return box;
}

// ---------------------------------------------------------------- markdown

/**
 * Markdown da fala de um agente. O renderizador escapa todo o texto e só gera
 * as próprias tags; aqui os links abrem fora do app e os blocos de código
 * ganham um botão de copiar.
 */
export function markdown(text: string): HTMLElement {
  const box = h('div', { class: 'md' });
  box.innerHTML = renderMarkdown(text, { highlight: true });
  for (const link of box.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const pre of box.querySelectorAll('pre')) {
    const code = pre.textContent;
    const button = h(
      'button',
      {
        class: 'copiar-codigo',
        type: 'button',
        'aria-label': l10n.t('Copy code'),
        onclick: () => void copy(code),
      },
      icon('copiar', 15),
    );
    const lang = pre.getAttribute('data-lang');
    const bar = h('div', { class: 'codigo-barra' }, h('span', {}, lang ?? l10n.t('code')), button);
    pre.before(bar);
    const wrap = h('div', { class: 'codigo' });
    bar.before(wrap);
    wrap.append(bar, pre);
  }
  return box;
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(l10n.t('Copied.'));
  } catch {
    toast(l10n.t("Couldn't copy in this browser."), 'erro');
  }
}

// ---------------------------------------------------------------- folha

/**
 * Folha que sobe de baixo, para menus e escolhas. Fecha ao tocar fora, no
 * botão ou num item.
 */
export function sheet(title: string, items: readonly SheetItem[]): void {
  const close = (): void => {
    backdrop.classList.add('saindo');
    setTimeout(() => {
      backdrop.remove();
    }, 200);
  };
  const list = h(
    'div',
    { class: 'folha', role: 'dialog', 'aria-label': title },
    h('div', { class: 'folha-pega', 'aria-hidden': 'true' }),
    h('p', { class: 'folha-titulo' }, title),
    ...items.map((item) =>
      item.kind === 'secao'
        ? h('p', { class: 'folha-secao' }, item.label)
        : h(
            'button',
            {
              class: `folha-item${item.danger ? ' perigo' : ''}${item.checked ? ' marcado' : ''}`,
              type: 'button',
              onclick: () => {
                close();
                item.run();
              },
            },
            item.icon ? icon(item.icon, 18) : h('span', { class: 'folha-vazio' }),
            h(
              'span',
              { class: 'folha-texto' },
              h('span', {}, item.label),
              item.description && h('small', {}, item.description),
            ),
            item.checked ? icon('check', 18) : null,
          ),
    ),
    h('button', { class: 'folha-fechar', type: 'button', onclick: close }, l10n.t('Close')),
  );
  const backdrop = h(
    'div',
    {
      class: 'fundo-folha',
      onclick: (event: Event) => {
        if (event.target === backdrop) close();
      },
    },
    list,
  );
  document.body.append(backdrop);
}

export type SheetItem =
  | { readonly kind: 'secao'; readonly label: string }
  | {
      readonly kind?: 'item';
      readonly label: string;
      readonly description?: string;
      readonly icon?: IconName;
      readonly danger?: boolean;
      readonly checked?: boolean;
      readonly run: () => void;
    };
