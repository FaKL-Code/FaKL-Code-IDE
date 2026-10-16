import type {
  AgentState,
  AgentThumbnailEventData,
  CafeAgent,
  CafeState,
  FaklEvent,
} from '@fakl/protocol';

import { mountCafe, STATE_LABEL } from '../src/index.js';

/*
 * Prévia do café com agentes de mentira, para ver a sala sem o Core e
 * conferir os PNGs novos de `assets/`: `pnpm --filter @fakl/cafe preview`.
 */

const params = new URLSearchParams(location.search);
const assets = params.get('assets');

const room = mountCafe({
  canvas: document.getElementById('cena') as HTMLCanvasElement,
  onOpen: (sessionId) => {
    const agent = agents.find((a) => a.sessionId === sessionId);
    status.textContent = agent ? `${agent.nome}: ${STATE_LABEL[agent.state] ?? agent.state}` : '';
  },
  onRefresh: () => undefined,
  ...(assets !== null ? { assets: { base: assets || 'assets/' } } : {}),
  // Na prévia o cochilo vem em 20 s para dar para ver o gato subir no colo.
  sleepAfterMs: 20_000,
});

const status = document.getElementById('status') as HTMLSpanElement;

let seq = 0;
function event(topic: FaklEvent['topic'], subject: string, data: unknown): FaklEvent {
  seq++;
  return { id: String(seq), ts: new Date().toISOString(), topic, subject, data };
}

const FILES = ['src/app.ts', 'room.ts', 'api/users.ts', 'README.md', 'build.mjs', 'auth.ts'];
const CODE = [
  '+ export function sala() {',
  '+   const cafe = abrir();',
  '-   return null;',
  '  if (agente.pronto) {',
  '+   servir(cafe);',
  '  }',
  '+ // FaKL-Code',
  '- velho();',
];

function thumb(i: number, kind: AgentThumbnailEventData['tipo']): AgentThumbnailEventData {
  if (kind === 'testes')
    return {
      tipo: 'testes',
      titulo: 'pnpm test',
      linhas: [],
      resultado: i % 3 === 0 ? 'ok' : 'rodando',
    };
  if (kind === 'comando')
    return {
      tipo: 'comando',
      titulo: 'pnpm build',
      linhas: ['$ pnpm build', 'compilando...', 'ok em 2.1s', 'dist/index.js'],
    };
  const lines = Array.from({ length: 6 }, (_, k) => CODE[(i + k) % CODE.length] ?? '');
  return { tipo: kind, titulo: FILES[i % FILES.length] ?? 'x.ts', linhas: lines };
}

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'lovable', 'ollama', 'anthropic', 'openai'];
const NAMES = [
  'Maestro',
  'Front',
  'Revisor',
  'Testes',
  'Docs',
  'Infra',
  'Pesquisa',
  'Design',
  'API',
  'Banco',
];
let agents: CafeAgent[] = [];
let made = 0;

function make(state: AgentState, extra: Partial<CafeAgent> = {}): CafeAgent {
  const i = made++;
  return {
    sessionId: `s${String(i)}`,
    nome: NAMES[i % NAMES.length] ?? `Agente ${String(i)}`,
    profileId: 'p',
    provedor: PROVIDERS[i % PROVIDERS.length] ?? 'anthropic',
    state,
    runId: 'r1',
    miniatura: thumb(i, i % 4 === 3 ? 'testes' : i % 4 === 2 ? 'comando' : 'arquivo'),
    ...extra,
  };
}

function apply(): void {
  const state: CafeState = {
    agentes: agents,
    placar: {
      dia: '2026-10-12',
      tarefas: 12 + made,
      prs: 4,
      custoUsd: 3.42 + made * 0.17,
      maxAgentes: 6,
      prsTotal: 87,
    },
    limites: [],
  };
  room.applyState(state);
}

function setState(agent: CafeAgent, state: AgentState): void {
  agents = agents.map((a) => (a.sessionId === agent.sessionId ? { ...a, state } : a));
  room.onEvent(event('agent.state', agent.sessionId, { state }));
}

const maestro = make('executando', { papel: 'maestro' });
agents = [
  maestro,
  make('executando', { parentSessionId: maestro.sessionId }),
  make('pensando', { parentSessionId: maestro.sessionId }),
  make('executando', { parentSessionId: maestro.sessionId }),
  make('aguardando-permissão', { parentSessionId: maestro.sessionId }),
  make('falhou', { parentSessionId: maestro.sessionId }),
  make('ocioso', { parentSessionId: maestro.sessionId }),
];
apply();

const CYCLE: AgentState[] = [
  'pensando',
  'executando',
  'executando',
  'aguardando-permissão',
  'executando',
  'pensando',
  'executando',
];
let tick = 0;

function concludeOne(): void {
  const working = agents.filter(
    (a) => a.papel !== 'maestro' && !['concluído', 'parado', 'falhou', 'ocioso'].includes(a.state),
  );
  const agent = working[tick % Math.max(1, working.length)];
  if (agent) setState(agent, 'concluído');
}

function spawnOne(): void {
  agents.push(make('preparando', { parentSessionId: maestro.sessionId }));
  apply();
  const added = agents[agents.length - 1];
  if (added)
    setTimeout(() => {
      setState(added, 'executando');
    }, 4_000);
}

function failOne(): void {
  const working = agents.filter((a) => a.papel !== 'maestro' && a.state === 'executando');
  const agent = working[0];
  if (agent) setState(agent, 'falhou');
}

setInterval(() => {
  tick++;
  for (const agent of agents) {
    if (
      agent.papel === 'maestro' ||
      ['concluído', 'parado', 'falhou', 'ocioso', 'preparando'].includes(agent.state)
    )
      continue;
    if ((tick + agent.sessionId.length) % 3 === 0) {
      const next = CYCLE[(tick + Number(agent.sessionId.slice(1))) % CYCLE.length] ?? 'executando';
      setState(agent, next);
    }
    const i = Number(agent.sessionId.slice(1)) + tick;
    room.onEvent(
      event(
        'agent.thumbnail',
        agent.sessionId,
        thumb(i, i % 5 === 0 ? 'testes' : i % 5 === 1 ? 'comando' : 'arquivo'),
      ),
    );
  }
  if (tick % 6 === 0) concludeOne();
  if (tick % 6 === 3) {
    // Quem já foi embora sai da lista; a sala nunca fica vazia.
    agents = agents.filter((a) => !['concluído', 'parado'].includes(a.state));
    if (agents.length < 8) spawnOne();
    else apply();
  }
  const failed = agents.find((a) => a.state === 'falhou');
  if (failed && tick % 5 === 0) setState(failed, 'executando');
}, 2_500);

const hourInput = document.getElementById('hora') as HTMLInputElement;
const hourLabel = document.getElementById('hora-valor') as HTMLSpanElement;
const auto = document.getElementById('auto') as HTMLInputElement;
function updateHour(): void {
  const h = Number(hourInput.value);
  hourLabel.textContent = auto.checked
    ? 'agora'
    : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  room.setHour(auto.checked ? undefined : h);
}
hourInput.addEventListener('input', () => {
  auto.checked = false;
  updateHour();
});
auto.addEventListener('change', updateHour);
updateHour();

document.getElementById('novo')?.addEventListener('click', spawnOne);
document.getElementById('concluir')?.addEventListener('click', concludeOne);
document.getElementById('falhar')?.addEventListener('click', failOne);
document.getElementById('limite')?.addEventListener('click', () => {
  room.onEvent(event('run.limit', 'r1', {}));
  setTimeout(() => {
    room.onEvent(event('run.done', 'r1', {}));
  }, 6_000);
});
