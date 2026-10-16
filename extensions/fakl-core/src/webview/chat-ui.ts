import { l10n } from '@fakl/i18n';

import {
  filterEntries,
  groupEntries,
  moveIndex,
  type LogoKey,
  type MenuEntry,
} from './chat-model.js';
import { icon, providerLogo, type IconName } from './icons.js';

/** Peças de interface do chat: criação de elementos, tooltips e popovers com teclado. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

let uid = 0;
export const nextId = (prefix: string): string => `${prefix}-${String(++uid)}`;

/** Botão só com ícone: rótulo acessível e tooltip próprio. */
export function iconButton(
  name: IconName,
  label: string,
  className = 'icon-btn',
): HTMLButtonElement {
  const button = el('button', { type: 'button', class: className, 'aria-label': label });
  button.dataset.tip = label;
  button.append(icon(name, 16));
  return button;
}

/** Troca o ícone de um botão por um check por um instante, depois de copiar. */
export function flashCopied(button: HTMLElement, name: IconName): void {
  button.replaceChildren(icon('check', 14));
  button.classList.add('done');
  setTimeout(() => {
    button.replaceChildren(icon(name, 14));
    button.classList.remove('done');
  }, 1400);
}

// --- Tooltips -------------------------------------------------------------

let tooltip: HTMLElement | undefined;
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
let tooltipTarget: HTMLElement | undefined;

function hideTooltip(): void {
  clearTimeout(tooltipTimer);
  tooltip?.remove();
  tooltip = undefined;
  tooltipTarget?.removeAttribute('aria-describedby');
  tooltipTarget = undefined;
}

function showTooltip(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (!text) return;
  hideTooltip();
  tooltipTarget = target;
  const id = nextId('tip');
  tooltip = el('div', { class: 'tooltip', role: 'tooltip', id }, text);
  document.body.append(tooltip);
  target.setAttribute('aria-describedby', id);
  const box = target.getBoundingClientRect();
  const tip = tooltip.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, box.left + box.width / 2 - tip.width / 2),
    window.innerWidth - tip.width - 8,
  );
  const above = box.top - tip.height - 6 >= 4;
  tooltip.style.left = `${String(left)}px`;
  tooltip.style.top = `${String(above ? box.top - tip.height - 6 : box.bottom + 6)}px`;
}

/** Tooltips por delegação: qualquer elemento com `data-tip` ganha o balão. */
export function installTooltips(): void {
  const find = (event: Event): HTMLElement | undefined =>
    (event.target as Element | null)?.closest<HTMLElement>('[data-tip]') ?? undefined;
  document.addEventListener('pointerover', (event) => {
    const target = find(event);
    if (!target || target === tooltipTarget) return;
    hideTooltip();
    tooltipTimer = setTimeout(() => {
      showTooltip(target);
    }, 450);
  });
  document.addEventListener('pointerout', (event) => {
    if (find(event)) hideTooltip();
  });
  document.addEventListener('focusin', (event) => {
    const target = find(event);
    if (target?.matches(':focus-visible')) showTooltip(target);
  });
  document.addEventListener('focusout', hideTooltip);
  document.addEventListener('pointerdown', hideTooltip, true);
  document.addEventListener('keydown', hideTooltip, true);
  window.addEventListener('blur', hideTooltip);
}

// --- Flutuantes -----------------------------------------------------------

interface Floating {
  readonly anchor: HTMLElement;
  readonly node: HTMLElement;
  readonly onClose?: () => void;
}

let floating: Floating | undefined;

export function floatingAnchor(): HTMLElement | undefined {
  return floating?.anchor;
}

export function closeFloating(restoreFocus = false): void {
  if (!floating) return;
  const { anchor, node, onClose } = floating;
  floating = undefined;
  node.remove();
  anchor.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (restoreFocus) anchor.focus();
}

/** Mostra `node` junto de `anchor`, para cima ou para baixo, sempre dentro da janela. */
export function openFloating(
  anchor: HTMLElement,
  node: HTMLElement,
  options: {
    placement?: 'up' | 'down';
    width?: number;
    onClose?: () => void;
    align?: 'start' | 'end';
  } = {},
): void {
  closeFloating();
  hideTooltip();
  const { placement = 'down', width = 280, align = 'start' } = options;
  node.classList.add('floating');
  node.style.width = `${String(Math.min(width, window.innerWidth - 16))}px`;
  document.body.append(node);
  const box = anchor.getBoundingClientRect();
  const w = node.getBoundingClientRect().width;
  const preferred = align === 'end' ? box.right - w : box.left;
  node.style.left = `${String(Math.min(Math.max(8, preferred), window.innerWidth - w - 8))}px`;
  const spaceAbove = box.top - 12;
  const spaceBelow = window.innerHeight - box.bottom - 12;
  // Se não cabe onde foi pedido, vai para o lado com mais espaço.
  const up =
    placement === 'up'
      ? spaceAbove >= 160 || spaceAbove >= spaceBelow
      : spaceBelow < 160 && spaceAbove > spaceBelow;
  if (up) {
    node.style.bottom = `${String(window.innerHeight - box.top + 6)}px`;
    node.style.maxHeight = `${String(Math.max(120, spaceAbove))}px`;
  } else {
    node.style.top = `${String(box.bottom + 6)}px`;
    node.style.maxHeight = `${String(Math.max(120, spaceBelow))}px`;
  }
  anchor.setAttribute('aria-expanded', 'true');
  floating = options.onClose ? { anchor, node, onClose: options.onClose } : { anchor, node };
}

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!floating) return;
    const target = event.target as Node;
    if (floating.node.contains(target) || floating.anchor.contains(target)) return;
    closeFloating();
  },
  true,
);
window.addEventListener('blur', () => {
  closeFloating();
});
window.addEventListener('resize', () => {
  closeFloating();
});

// --- Menu com filtro e teclado --------------------------------------------

export interface MenuItem extends MenuEntry {
  /** Ícone à esquerda: nome do conjunto ou um nó já pronto (ícone de arquivo, avatar). */
  readonly icon?: IconName | (() => Element);
  /** Texto pequeno à direita, como o atalho ou o estado. */
  readonly detail?: string;
  readonly checked?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

export interface MenuOptions<T extends MenuItem> {
  readonly label: string;
  /** Campo de busca no topo, com foco; sem ele a lista recebe o foco. */
  readonly searchable?: boolean;
  readonly placeholder?: string;
  readonly empty?: string;
  readonly placement?: 'up' | 'down';
  readonly width?: number;
  readonly align?: 'start' | 'end';
  /** O foco fica em outro campo (como o menu @ no textarea); o teclado chega por `handleKey`. */
  readonly external?: boolean;
  /** Filtro já feito por quem chama (resultado do host); o menu não refiltra. */
  readonly prefiltered?: boolean;
  readonly onPick: (item: T) => void;
  readonly onClose?: () => void;
}

export interface MenuHandle<T extends MenuItem> {
  setItems(items: readonly T[]): void;
  close(restoreFocus?: boolean): void;
  /** Teclas de navegação; devolve se tratou a tecla. */
  handleKey(event: KeyboardEvent): boolean;
  readonly listId: string;
  activeId(): string | undefined;
}

export function openMenu<T extends MenuItem>(
  anchor: HTMLElement,
  initial: readonly T[],
  options: MenuOptions<T>,
): MenuHandle<T> {
  const listId = nextId('menu');
  const node = el('div', { class: 'popover menu', role: 'dialog', 'aria-label': options.label });
  let items = [...initial];
  let visible: T[] = [];
  let active = 0;
  let query = '';

  const search = options.searchable
    ? el('input', {
        type: 'text',
        class: 'menu-search',
        placeholder: options.placeholder ?? l10n.t('Filter'),
        'aria-label': options.placeholder ?? l10n.t('Filter'),
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': listId,
        autocomplete: 'off',
        spellcheck: 'false',
      })
    : undefined;
  const list = el('div', {
    class: 'menu-list',
    role: 'listbox',
    id: listId,
    'aria-label': options.label,
  });
  if (!search && !options.external) list.tabIndex = 0;
  if (search) node.append(el('div', { class: 'menu-search-box' }), list);
  else node.append(list);
  if (search) node.firstElementChild?.append(icon('search', 14), search);

  const optionId = (index: number): string => `${listId}-o${String(index)}`;

  const syncActive = (): void => {
    list.querySelectorAll('[role=option]').forEach((option, index) => {
      const on = index === active;
      option.classList.toggle('active', on);
      option.setAttribute('aria-selected', String(on));
      if (on) (option as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
    const id = visible.length > 0 ? optionId(active) : '';
    if (search) search.setAttribute('aria-activedescendant', id);
    else list.setAttribute('aria-activedescendant', id);
  };

  const pick = (index: number): void => {
    const item = visible[index];
    if (!item || item.disabled) return;
    close(!options.external);
    options.onPick(item);
  };

  const draw = (): void => {
    visible = options.prefiltered || !search ? items : filterEntries(items, query);
    active = Math.min(active, Math.max(0, visible.length - 1));
    list.replaceChildren();
    if (visible.length === 0) {
      list.append(el('div', { class: 'menu-empty' }, options.empty ?? l10n.t('Nothing found')));
      syncActive();
      return;
    }
    let index = 0;
    // Com busca ativa a ordem é por relevância; sem ela, agrupa.
    const groups = query ? [{ group: '', entries: visible }] : groupEntries(visible);
    visible = groups.flatMap((g) => g.entries);
    for (const { group, entries } of groups) {
      const section = el('div', { class: 'menu-group', role: 'group' });
      if (group) {
        const title = nextId('grp');
        section.append(el('div', { class: 'menu-group-title', id: title }, group));
        section.setAttribute('aria-labelledby', title);
      }
      for (const item of entries) {
        const i = index++;
        if (item.separatorBefore)
          section.append(el('div', { class: 'menu-sep', role: 'separator' }));
        const row = el('div', {
          role: 'option',
          id: optionId(i),
          class: `menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`,
          'aria-selected': 'false',
          ...(item.checked !== undefined ? { 'aria-checked': String(item.checked) } : {}),
          ...(item.disabled ? { 'aria-disabled': 'true' } : {}),
        });
        const lead = el('span', { class: 'menu-icon' });
        if (item.icon) {
          lead.append(typeof item.icon === 'string' ? icon(item.icon, 15) : item.icon());
        }
        const body = el('span', { class: 'menu-body' });
        body.append(el('span', { class: 'menu-label' }, item.label));
        if (item.description) body.append(el('span', { class: 'menu-desc' }, item.description));
        row.append(lead, body);
        if (item.detail) row.append(el('span', { class: 'menu-detail' }, item.detail));
        if (item.checked) row.append(el('span', { class: 'menu-check' }, ''));
        if (item.checked) row.lastElementChild?.append(icon('check', 14));
        row.addEventListener('pointerdown', (event) => {
          // Não tira o foco do campo de onde o menu veio.
          event.preventDefault();
        });
        row.addEventListener('click', () => {
          pick(i);
        });
        row.addEventListener('pointermove', () => {
          if (active !== i) {
            active = i;
            syncActive();
          }
        });
        section.append(row);
      }
      list.append(section);
    }
    syncActive();
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        active = moveIndex(active, event.key === 'ArrowDown' ? 1 : -1, visible.length);
        syncActive();
        return true;
      case 'Home':
        if (search && event.currentTarget === search) return false;
        event.preventDefault();
        active = 0;
        syncActive();
        return true;
      case 'End':
        if (search && event.currentTarget === search) return false;
        event.preventDefault();
        active = Math.max(0, visible.length - 1);
        syncActive();
        return true;
      case 'Enter':
      case 'Tab':
        if (event.key === 'Tab' && !options.external) {
          close(false);
          return false;
        }
        if (event.isComposing || visible.length === 0) return false;
        event.preventDefault();
        pick(active);
        return true;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return true;
      default:
        return false;
    }
  };

  const close = (restoreFocus = false): void => {
    if (floatingAnchor() === anchor) closeFloating(restoreFocus && !options.external);
  };

  openFloating(anchor, node, {
    placement: options.placement ?? 'down',
    width: options.width ?? 280,
    align: options.align ?? 'start',
    ...(options.onClose ? { onClose: options.onClose } : {}),
  });
  draw();

  if (search) {
    search.addEventListener('input', () => {
      query = search.value;
      active = 0;
      draw();
    });
    search.addEventListener('keydown', handleKey);
    search.focus();
  } else if (!options.external) {
    list.addEventListener('keydown', handleKey);
    list.focus();
  }

  return {
    listId,
    setItems(next): void {
      items = [...next];
      draw();
    },
    close,
    handleKey,
    activeId: () => (visible.length > 0 ? optionId(active) : undefined),
  };
}

/**
 * Avatar redondo do agente: a logo oficial do provedor quando há (`logo`), senão
 * as iniciais, na cor do provedor.
 */
export function avatar(initials: string, color: string, size = 24, logo?: LogoKey): HTMLElement {
  const node = el('span', { class: logo ? 'avatar has-logo' : 'avatar', 'aria-hidden': 'true' });
  if (logo) node.append(providerLogo(logo, Math.round(size * 0.62)));
  else node.textContent = initials;
  node.style.setProperty('--avatar', color);
  node.style.width = `${String(size)}px`;
  node.style.height = `${String(size)}px`;
  node.style.fontSize = `${String(Math.round(size * 0.42))}px`;
  return node;
}
