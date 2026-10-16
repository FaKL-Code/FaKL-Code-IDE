import { mountCafe, type CafeRoom } from '@fakl/cafe';
import { useLocale } from '@fakl/i18n';
import type { AgentThumbnailEventData, CafeAgent, FaklEvent } from '@fakl/protocol';

import { langDoDocumento } from '../i18n';

/*
 * O café de verdade (@fakl/cafe), com o mesmo elenco do filme: Maestro, Codex,
 * Gemini, Claude e um modelo local. A sala é uma só; cada cena que mostra o
 * café empresta o canvas para a sua câmera.
 *
 * O canvas tem 1280x720 de CSS e é ampliado 3x: a sala sai em escala inteira e
 * fica no mesmo espaço de 3840x2160 dos clipes do filme, então as câmeras e o
 * monitor do Codex usam as mesmas coordenadas.
 */

export interface Sala {
  readonly canvas: HTMLCanvasElement;
  /** Coloca a sala na câmera de uma cena, com a hora do dia. */
  colocar(slot: HTMLElement, hora: number): void;
  /** Claude conclui (confete) e fica ocioso. */
  concluir(): void;
  /** Claude, ocioso, vai ao bebedouro. */
  irAgua(): void;
  /** Todos voltam a trabalhar. */
  trabalhar(): void;
  /** Claude para de trabalhar e cochila à noite. */
  cochilar(): void;
  pausar(): void;
  retomar(): void;
}

const CODIGO = [
  '+ export async function buscar(t) {',
  '+   const alvo = t.trim();',
  '-   return null;',
  '  if (alvo) {',
  '+   return filtrar(alvo);',
  '  }',
  '+ // npm test: ok',
  '- velho();',
];
const ARQUIVOS = ['users.ts', 'users.test.ts', 'README.md', 'api.ts', 'deploy.sh', 'mesa.ts'];

function miniatura(i: number): AgentThumbnailEventData {
  if (i % 5 === 3) return { tipo: 'testes', titulo: 'npm test', linhas: [], resultado: 'rodando' };
  if (i % 5 === 4)
    return {
      tipo: 'comando',
      titulo: 'npm run build',
      linhas: ['$ npm run build', 'compilando...', 'ok em 2.1s'],
    };
  const linhas = Array.from({ length: 6 }, (_, k) => CODIGO[(i + k) % CODIGO.length] ?? '');
  return { tipo: 'arquivo', titulo: ARQUIVOS[i % ARQUIVOS.length] ?? 'x.ts', linhas };
}

const ELENCO: readonly (readonly [string, string, string, boolean])[] = [
  ['m', 'Maestro', 'anthropic', true],
  ['a', 'Codex', 'openai', false],
  ['b', 'Gemini', 'gemini', false],
  ['c', 'Claude', 'anthropic', false],
  ['d', 'Local', 'ollama', false],
];

export function criarSala(): Sala {
  // O café (@fakl/cafe) traduz os próprios textos pelo idioma da página.
  useLocale(langDoDocumento() === 'en' ? 'en' : 'pt-BR');
  const canvas = document.createElement('canvas');
  canvas.className = 'sala';
  canvas.setAttribute('aria-hidden', 'true');
  // A sala mede o canvas ao montar: ele precisa estar no documento.
  const berco = document.createElement('div');
  berco.className = 'sala-berco';
  berco.appendChild(canvas);
  document.body.appendChild(berco);

  const room: CafeRoom = mountCafe({
    canvas,
    onOpen: () => undefined,
    onRefresh: () => undefined,
    sleepAfterMs: 5_000,
  });
  // A sala aceita zoom e arrasto; aqui ela é cenário, a rolagem é da página.
  canvas.style.touchAction = 'auto';

  let seq = 0;
  const evento = (topic: FaklEvent['topic'], subject: string, data: unknown): FaklEvent => {
    seq++;
    return { id: String(seq), ts: new Date().toISOString(), topic, subject, data };
  };

  let agentes: CafeAgent[] = ELENCO.map(([id, nome, provedor, maestro], i) => ({
    sessionId: id,
    nome,
    profileId: provedor,
    provedor,
    state: 'executando',
    runId: id === 'c' ? 'r2' : 'r1',
    miniatura: miniatura(i),
    ...(maestro ? { papel: 'maestro' as const } : { parentSessionId: 'm' }),
  }));
  room.applyState({
    agentes,
    placar: { dia: '2026-10-15', tarefas: 14, prs: 5, custoUsd: 1.65, maxAgentes: 5, prsTotal: 87 },
    limites: [],
  });

  const estado = (id: string, state: CafeAgent['state']): void => {
    const atual = agentes.find((a) => a.sessionId === id);
    if (!atual || atual.state === state) return;
    agentes = agentes.map((a) => (a.sessionId === id ? { ...a, state } : a));
    room.onEvent(evento('agent.state', id, { state }));
  };

  // As telas mudam enquanto eles trabalham, como o Core faz.
  let tick = 0;
  let ativa = true;
  window.setInterval(() => {
    if (!ativa || document.hidden) return;
    tick++;
    agentes.forEach((a, i) => {
      if (a.state === 'executando')
        room.onEvent(evento('agent.thumbnail', a.sessionId, miniatura(i + tick)));
    });
  }, 1_200);

  let hora = -1;
  return {
    canvas,
    colocar(slot, h) {
      if (canvas.parentElement !== slot) slot.appendChild(canvas);
      if (h !== hora) {
        hora = h;
        room.setHour(h);
      }
    },
    concluir() {
      if (agentes.find((a) => a.sessionId === 'c')?.state !== 'executando') return;
      room.onEvent(evento('run.round', 'r2', { veredito: 'passou' }));
      estado('c', 'ocioso');
    },
    irAgua() {
      room.setActivity('c', 'bebedouro', 60_000);
    },
    trabalhar() {
      estado('c', 'executando');
    },
    cochilar() {
      estado('c', 'ocioso');
    },
    pausar() {
      ativa = false;
      room.pause();
    },
    retomar() {
      ativa = true;
      room.resume();
    },
  };
}
