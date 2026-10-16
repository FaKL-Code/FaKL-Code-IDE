import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { initFilme } from '../filme/filme';
import { lenis, reducedMotion } from './chrome';

gsap.registerPlugin(ScrollTrigger);

/** A página inicial: o filme preso à rolagem e, depois dele, o conteúdo que entra ao passar. */
export function initPagina(): void {
  lenis?.on('scroll', () => {
    ScrollTrigger.update();
  });
  initFilme();
  if (reducedMotion()) return;
  // Os créditos sobem junto com a rolagem, como num rolo de cinema: cada linha
  // acende enquanto passa pela parte de baixo da tela, sem saltos nem atraso.
  for (const el of document.querySelectorAll<HTMLElement>('[data-revela]')) {
    gsap.fromTo(
      el,
      { opacity: 0.08, y: 36 },
      {
        opacity: 1,
        y: 0,
        ease: 'none',
        scrollTrigger: { trigger: el, start: 'top 98%', end: 'top 72%', scrub: true },
      },
    );
  }
  // O filme muda a altura da página quando mede; os gatilhos precisam saber.
  void document.fonts.ready.then(() => {
    ScrollTrigger.refresh();
  });
  window.addEventListener('load', () => {
    ScrollTrigger.refresh();
  });
}
