import { isMaestro, mountCafe, OTHER_COLORS, PROVIDER_COLORS, STATE_LABEL } from '@fakl/cafe';
import { l10n, useLocale } from '@fakl/i18n';

import type { FromCafe, ToCafe } from '../cafe-protocol.js';

/*
 * Painel do cyber café na IDE: a sala de `@fakl/cafe` e, abaixo dela, a faixa
 * com a tela legível de cada agente. Conversa com a extensão por mensagens.
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

const strip = document.getElementById('telas') as HTMLDivElement;
const notice = document.getElementById('aviso') as HTMLParagraphElement;

function renderStrip(): void {
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
        duration.min = '1';
        duration.max = '60';
        duration.value = '2';
        duration.setAttribute(
          'aria-label',
          l10n.t('Activity duration for {0}, in minutes', seat.agent.nome),
        );
        const start = document.createElement('button');
        start.type = 'button';
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

window.addEventListener('message', (event: MessageEvent<ToCafe>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      room.setOffline(false);
      room.applyState(message.state);
      return;
    case 'event':
      room.onEvent(message.event);
      return;
    case 'offline':
      room.setOffline(true);
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
vscode.postMessage({ type: 'ready' });
