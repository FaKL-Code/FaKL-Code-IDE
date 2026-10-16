/**
 * Prévia do overlay com um Core de mentira. `?forma=` abre uma forma:
 * `pet` (padrão), `painel`, `conversa`, `nova` ou `encerrados`;
 * `?cenario=calmo` tira os pedidos e o limite; `?offline` simula o Core fora.
 */
import { fake } from './install.js';
import '../src/main.js';

const forma = new URLSearchParams(location.search).get('forma') ?? 'pet';

setTimeout(() => {
  switch (forma) {
    case 'painel':
      fake.command('painel');
      break;
    case 'encerrados':
      fake.command('painel');
      setTimeout(() => {
        document.querySelector<HTMLElement>('.encerrados summary')?.click();
      }, 100);
      break;
    case 'nova':
      fake.command('compor');
      break;
    case 'conversa':
      fake.command('painel');
      setTimeout(() => {
        document.querySelector<HTMLButtonElement>('.agente-abrir')?.click();
      }, 100);
      break;
    default:
      break;
  }
}, 500);
