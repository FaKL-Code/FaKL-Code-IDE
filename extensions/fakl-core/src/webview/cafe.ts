import {
  Announcer,
  AnnouncerGroup,
  describeKitchen,
  describeRoom,
  describeSeat,
  isMaestro,
  mountCafe,
  mountKitchen,
  OTHER_COLORS,
  PROVIDER_COLORS,
  renderKitchenCards,
  renderKitchenList,
  RunAnnouncer,
  STATE_LABEL,
  type SeatInfo,
} from '@fakl/cafe';
import { l10n, useLocale } from '@fakl/i18n';

import type { CiRun, ExternalSession } from '@fakl/protocol';

import type { FromCafe, ToCafe } from '../cafe-protocol.js';
import { initCoach } from './coach.js';

/*
 * Painel do cyber café na IDE: a sala de `@fakl/cafe` e, abaixo dela, a faixa
 * com a tela legível de cada agente. Conversa com a extensão por mensagens.
 *
 * Para teclado e leitor de tela (RNF-14): uma lista escondida com cada agente e
 * seu estado (Enter ou Espaço abre a conversa) e uma região `aria-live=polite`
 * que anuncia as mudanças de estado agrupadas, no máximo a cada 5 s.
 */

interface VsCodeApi {
  postMessage(message: FromCafe): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();

const sala = document.getElementById('sala') as HTMLDivElement;

function assetFiles(): string[] {
  try {
    return JSON.parse(sala.dataset.files ?? '[]') as string[];
  } catch {
    return [];
  }
}

const files = assetFiles();
const room = mountCafe({
  canvas: document.getElementById('cena') as HTMLCanvasElement,
  // Só pede os PNGs que existem; o resto fica no desenho provisório.
  ...(files.length > 0 && sala.dataset.assets
    ? { assets: { base: sala.dataset.assets, files } }
    : {}),
  onOpen: (sessionId) => {
    vscode.postMessage({ type: 'open', sessionId });
  },
  onRefresh: () => {
    vscode.postMessage({ type: 'refresh' });
  },
  onChange: () => {
    renderStrip();
  },
});

const kitchenBlock = document.getElementById('cozinha-bloco') as HTMLDivElement;
const kitchenCanvas = document.getElementById('cozinha') as HTMLCanvasElement;
const kitchenList = document.getElementById('ci-presentes') as HTMLUListElement;
const kitchenCards = document.getElementById('ci-telas') as HTMLDivElement;

function openRun(run: CiRun): void {
  vscode.postMessage({ type: 'ciAbrir', repo: run.repo, id: run.id, url: run.url });
}

const kitchen = mountKitchen({
  canvas: kitchenCanvas,
  onOpen: openRun,
  onChange: () => {
    renderKitchen();
  },
});

/** Cozinha do CI: só aparece com repositórios acompanhados; lista, cartões e anúncios seguem a bancada. */
function renderKitchen(): void {
  const status = kitchen.status;
  const runs = kitchen.runs();
  const visible = status !== undefined && status.repos.length > 0;
  kitchenBlock.hidden = !visible;
  kitchenCanvas.setAttribute(
    'aria-label',
    [
      describeKitchen(status) || l10n.t('CI kitchen'),
      runs.length === 0 ? l10n.t('No runs yet.') : '',
    ]
      .filter(Boolean)
      .join('. '),
  );
  renderKitchenList(kitchenList, runs, { onOpen: openRun });
  renderKitchenCards(kitchenCards, runs, { onOpen: openRun });
  if (visible) {
    // A primeira leitura fixa o ponto de partida; só o que muda depois é anunciado.
    runAnnouncer.observe(runs);
    if (loaded) scheduleAnnouncement();
  }
}

const strip = document.getElementById('telas') as HTMLDivElement;
const present = document.getElementById('presentes') as HTMLUListElement;
const live = document.getElementById('anuncio') as HTMLDivElement;
const scene = document.getElementById('cena') as HTMLCanvasElement;
const notice = document.getElementById('aviso') as HTMLParagraphElement;

// ---------------------------------------------------------------- acessibilidade

const ANNOUNCE_EVERY_MS = 5_000;
const announcer = new Announcer({ minIntervalMs: ANNOUNCE_EVERY_MS });
/** Resultados do CI entram na mesma região `aria-live`, agrupados com os dos agentes. */
const runAnnouncer = new RunAnnouncer({ minIntervalMs: ANNOUNCE_EVERY_MS });
const speech = new AnnouncerGroup(announcer, runAnnouncer);
let announceTimer: number | undefined;
/** Antes do primeiro retrato do café não há o que comparar (e não se anuncia a chegada de todos). */
let loaded = false;
let presentSignature = '';

function seatInfos(): SeatInfo[] {
  const limited = room.limited();
  return room.seats().map((seat) => ({
    id: seat.agent.sessionId,
    name: seat.agent.nome,
    state: seat.agent.state,
    limited: seat.agent.runId !== undefined && limited.has(seat.agent.runId),
    ...((seat.thumb?.titulo ?? seat.agent.papel)
      ? { detail: seat.thumb?.titulo ?? seat.agent.papel }
      : {}),
  }));
}

function scheduleAnnouncement(): void {
  if (announceTimer !== undefined) return;
  const wait = speech.waitMs(Date.now());
  if (wait === undefined) return;
  announceTimer = window.setTimeout(() => {
    announceTimer = undefined;
    const text = speech.take(Date.now());
    if (text) live.textContent = text;
    scheduleAnnouncement();
  }, wait);
}

/** Lista escondida, resumo da sala e anúncios; só mexe no DOM se o texto mudou. */
function renderAccessible(): void {
  const infos = seatInfos();
  scene.setAttribute(
    'aria-label',
    `${l10n.t('Cyber café room with the agents')}. ${describeRoom(infos, room.offline)}`,
  );
  const signature = infos.map((info) => `${info.id}|${describeSeat(info)}`).join('||');
  if (signature !== presentSignature) {
    presentSignature = signature;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset.sessionId;
    present.replaceChildren(
      ...infos.map((info) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.sessionId = info.id;
        button.textContent = describeSeat(info);
        button.title = l10n.t('Open conversation with {0}', info.name);
        // Enter e Espaço já ativam o botão e disparam o `click`: o mesmo do personagem.
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', sessionId: info.id });
        });
        item.append(button);
        return item;
      }),
    );
    if (focusedId) {
      present.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(focusedId)}"]`)?.focus();
    }
  }
  if (loaded) {
    announcer.observe(infos);
    scheduleAnnouncement();
  }
}

/** Foco, valores digitados e escolhas sobrevivem a quando a faixa se refaz a cada evento. */
function keepInputs(rebuild: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && strip.contains(active) ? active.dataset.foco : undefined;
  const values = new Map<string, string>();
  for (const field of strip.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'select[data-foco], input[data-foco]',
  )) {
    if (field.dataset.foco) values.set(field.dataset.foco, field.value);
  }
  rebuild();
  for (const field of strip.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'select[data-foco], input[data-foco]',
  )) {
    const saved = field.dataset.foco ? values.get(field.dataset.foco) : undefined;
    if (saved !== undefined) field.value = saved;
  }
  if (focusKey) {
    strip.querySelector<HTMLElement>(`[data-foco="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

function renderStrip(): void {
  renderAccessible();
  keepInputs(drawStrip);
}

function drawStrip(): void {
  const list = room.seats();
  strip.replaceChildren(
    ...list.map((seat) => {
      const card = document.createElement('article');
      card.className = 'tela';
      card.setAttribute('role', 'listitem');
      card.dataset.estado = seat.agent.state;
      const [color] = PROVIDER_COLORS[seat.agent.provedor] ?? OTHER_COLORS;
      card.style.setProperty('--cor', color);
      const head = document.createElement('div');
      head.className = 'cabeca';
      const name = document.createElement('strong');
      name.textContent = isMaestro(seat.agent) ? `🎧 ${seat.agent.nome}` : seat.agent.nome;
      const state = document.createElement('span');
      state.textContent = STATE_LABEL[seat.agent.state] ?? seat.agent.state;
      head.append(name, state);
      const title = document.createElement('div');
      title.className = 'titulo';
      title.textContent = seat.thumb?.titulo ?? seat.agent.papel ?? '';
      const body = document.createElement('pre');
      const thumb = seat.thumb;
      if (thumb?.tipo === 'testes') {
        body.textContent =
          thumb.resultado === 'ok'
            ? l10n.t('✔ tests passed')
            : thumb.resultado === 'falhou'
              ? l10n.t('✘ tests failed')
              : l10n.t('… running tests');
        body.dataset.resultado = thumb.resultado ?? '';
      } else {
        for (const line of thumb?.linhas ?? []) {
          const span = document.createElement('span');
          span.textContent = `${line}\n`;
          if (thumb?.tipo === 'arquivo' && line.startsWith('+')) span.className = 'mais';
          if (thumb?.tipo === 'arquivo' && line.startsWith('-')) span.className = 'menos';
          body.append(span);
        }
      }
      body.dataset.tipo = thumb?.tipo ?? 'ocioso';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'tela-abrir';
      open.dataset.foco = `${seat.agent.sessionId}:abrir`;
      open.title = l10n.t('Open conversation with {0}', seat.agent.nome);
      open.append(head, title, body);
      open.addEventListener('click', () => {
        vscode.postMessage({ type: 'open', sessionId: seat.agent.sessionId });
      });
      card.append(open);
      if (seat.agent.state === 'ocioso') {
        const controls = document.createElement('div');
        controls.className = 'atividade';
        const activity = document.createElement('select');
        activity.setAttribute('aria-label', l10n.t('Activity for {0}', seat.agent.nome));
        activity.dataset.foco = `${seat.agent.sessionId}:atividade`;
        const choices = [
          ['sinuca', l10n.t('Pool')],
          ['fliperama', l10n.t('Arcade')],
          ['cafe', l10n.t('Coffee')],
          ['bebedouro', l10n.t('Water cooler')],
          ['conversa', l10n.t('Talk')],
        ] as const;
        for (const [value, label] of choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          activity.append(option);
        }
        const duration = document.createElement('input');
        duration.type = 'number';
        duration.dataset.foco = `${seat.agent.sessionId}:minutos`;
        duration.min = '1';
        duration.max = '60';
        duration.value = '2';
        duration.setAttribute(
          'aria-label',
          l10n.t('Activity duration for {0}, in minutes', seat.agent.nome),
        );
        const start = document.createElement('button');
        start.type = 'button';
        start.dataset.foco = `${seat.agent.sessionId}:enviar`;
        start.textContent = l10n.t('Send');
        start.title = l10n.t('Send the agent to the activity for the chosen time');
        start.addEventListener('click', () => {
          const minutes = Number(duration.value);
          const started =
            Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
              ? room.setActivity(
                  seat.agent.sessionId,
                  activity.value as 'sinuca' | 'fliperama' | 'cafe' | 'bebedouro' | 'conversa',
                  minutes * 60_000,
                )
              : false;
          status.textContent = started
            ? l10n.t('On the way')
            : l10n.t('Choose 1–60 min; the spot may be taken');
        });
        const status = document.createElement('span');
        status.setAttribute('aria-live', 'polite');
        controls.append(activity, duration, start, status);
        card.append(controls);
      }
      return card;
    }),
  );
  strip.hidden = list.length === 0;
  notice.hidden = !room.offline && list.length > 0;
  notice.textContent = room.offline
    ? l10n.t('FaKL Core is not connected.')
    : l10n.t('Nobody in the café. Use + Agent or + Task and whoever arrives takes a PC.');
}

const externalStrip = document.getElementById('externas') as HTMLDivElement;
const EXTERNAL_NAMES = { codex: 'Codex', 'claude-code': 'Claude Code' } as const;

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Conversas das extensões do Codex e do Claude Code: só leitura, marcadas como externas. */
function renderExternal(sessions: readonly ExternalSession[]): void {
  externalStrip.replaceChildren(
    ...sessions.map((session) => {
      const card = document.createElement('article');
      card.className = 'tela externa';
      card.setAttribute('role', 'listitem');
      card.dataset.estado = session.estado;
      const [color] = PROVIDER_COLORS[session.provedor] ?? OTHER_COLORS;
      card.style.setProperty('--cor', color);
      const head = document.createElement('div');
      head.className = 'cabeca';
      const name = document.createElement('strong');
      name.textContent = EXTERNAL_NAMES[session.fonte];
      const state = document.createElement('span');
      state.textContent = session.estado === 'ativa' ? l10n.t('active') : l10n.t('idle');
      head.append(name, state);
      const title = document.createElement('div');
      title.className = 'titulo';
      title.textContent = session.titulo ?? folderName(session.pasta);
      title.title = session.pasta;
      const badge = document.createElement('span');
      badge.className = 'selo-externa';
      badge.textContent = l10n.t('external, read-only');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'externa-abrir';
      open.textContent = l10n.t('Open in extension');
      open.title = l10n.t(
        'Open this conversation in its own extension; the café cannot send messages to it',
      );
      open.addEventListener('click', () => {
        vscode.postMessage({ type: 'externasAbrir', id: session.id });
      });
      card.append(head, title, badge, open);
      return card;
    }),
  );
  externalStrip.hidden = sessions.length === 0;
}

window.addEventListener('message', (event: MessageEvent<ToCafe>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      room.setOffline(false);
      kitchen.setOffline(false);
      room.applyState(message.state);
      kitchen.apply(message.state.ci);
      if (!loaded) {
        // O primeiro retrato é o ponto de partida: só as mudanças depois dele são anunciadas.
        loaded = true;
        renderAccessible();
      }
      return;
    case 'event':
      // Execuções do CI vão para a cozinha; o resto, para a sala.
      if (message.event.topic === 'ci.run') kitchen.onRun(message.event.data as CiRun);
      else room.onEvent(message.event);
      return;
    case 'externas':
      renderExternal(message.sessoes);
      return;
    case 'offline':
      room.setOffline(true);
      kitchen.setOffline(true);
      renderExternal([]);
      return;
  }
});

document.getElementById('novo-agente')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'newAgent' });
});
document.getElementById('nova-tarefa')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'newTask' });
});

renderStrip();
renderKitchen();
// Duração das execuções em andamento anda sozinha: refaz os cartões de vez em quando.
window.setInterval(renderKitchen, 10_000);
vscode.postMessage({ type: 'ready' });
initCoach(vscode, 'cafe');
