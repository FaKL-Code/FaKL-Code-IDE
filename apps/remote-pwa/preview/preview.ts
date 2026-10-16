/**
 * Prévia do app do celular com uma IDE de mentira. `?tela=` abre uma tela
 * (conversa, caixa, tarefas, uso, tarefa, nova-conversa, encerrados, menu).
 */
import '../src/main.js';

import { app } from '../src/app.js';

const tela = new URLSearchParams(location.search).get('tela');

setTimeout(() => {
  switch (tela) {
    case 'conversa':
    case 'detalhes':
      app.go({ name: 'conversa', sessionId: 's1' });
      if (tela === 'detalhes') {
        setTimeout(() => {
          document.querySelector<HTMLButtonElement>('.faixa')?.click();
        }, 200);
      }
      break;
    case 'menu':
      app.go({ name: 'conversa', sessionId: 's1' });
      setTimeout(() => {
        document.querySelector<HTMLButtonElement>('.topo .botao-icone:last-child')?.click();
      }, 200);
      break;
    case 'caixa':
    case 'tarefas':
    case 'uso':
      app.go({ name: tela });
      break;
    case 'tarefa':
      app.go({ name: 'tarefas' });
      app.go({ name: 'tarefa', taskId: 't1' });
      break;
    case 'nova-conversa':
      app.go({ name: 'nova-conversa' });
      break;
    case 'encerrados':
      document.querySelector<HTMLElement>('.encerrados summary')?.click();
      break;
    default:
      break;
  }
}, 400);

// Para conferir a largura numa captura sem tela (`--dump-dom`).
setTimeout(() => {
  document.body.dataset.largura = `${String(innerWidth)}/${String(document.documentElement.scrollWidth)}`;
}, 1_000);
