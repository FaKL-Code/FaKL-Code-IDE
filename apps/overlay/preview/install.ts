/**
 * Põe a ponte de mentira no lugar do preload, antes do app carregar. A
 * moldura tracejada mostra o tamanho que a janela teria em cada forma.
 */
import { FakeCore } from './fake-core.js';

export const fake = new FakeCore();
window.faklOverlay = fake;

fake.onModeChange = (mode) => {
  document.documentElement.dataset.janela = mode;
};
document.documentElement.dataset.janela = 'pet';
document.documentElement.dataset.lado = fake.side;
