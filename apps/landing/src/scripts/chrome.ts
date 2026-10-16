import Lenis from 'lenis';

/** Rolagem suave compartilhada com as cenas da landing (ScrollTrigger). */
export let lenis: Lenis | undefined;

export const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Navegação, menu do celular, filme e rolagem suave: vale para todas as páginas. */
export function initChrome(): void {
  const menu = document.querySelector<HTMLElement>('[data-menu]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-toggle]');

  if (!reducedMotion()) {
    lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1, anchors: { offset: -72 } });
    const raf = (time: number): void => {
      lenis?.raf(time);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }

  const setMenu = (open: boolean): void => {
    menu?.toggleAttribute('data-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    toggle?.setAttribute('aria-label', (open ? toggle.dataset.fechar : toggle.dataset.abrir) ?? '');
  };
  toggle?.addEventListener('click', () => {
    setMenu(!(menu?.hasAttribute('data-open') ?? false));
  });
  menu?.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      setMenu(false);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenu(false);
  });

  // Filme: <dialog> nativo devolve o foco e fecha com Esc.
  const dialog = document.querySelector<HTMLDialogElement>('[data-filme]');
  let opener: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>('[data-filme-abrir]').forEach((button) => {
    button.addEventListener('click', () => {
      opener = button;
      dialog?.showModal();
      lenis?.stop();
      void dialog
        ?.querySelector('video')
        ?.play()
        .catch(() => undefined);
    });
  });
  const close = (): void => {
    dialog?.close();
  };
  dialog?.querySelector('[data-filme-fechar]')?.addEventListener('click', close);
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog?.addEventListener('close', () => {
    dialog.querySelector('video')?.pause();
    lenis?.start();
    opener?.focus();
  });
}
