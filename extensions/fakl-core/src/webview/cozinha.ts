import {
  describeKitchen,
  Descarte,
  mountKitchen,
  RunAnnouncer,
  renderKitchenCards,
  renderKitchenList,
  type DispensadasSalvas,
} from '@fakl/cafe';
import { l10n, useLocale } from '@fakl/i18n';
import type { CiRun } from '@fakl/protocol';

import type { FromCozinha, ToCozinha } from '../ci-panel-protocol.js';

/*
 * Cozinha do CI em tela própria (ADR 0053). A bancada e os cartões são os de
 * `@fakl/cafe`; aqui ficam as saídas para o que já passou, como no café e na
 * Mesa: dispensar uma execução (o x do cartão), limpar as concluídas e mostrar
 * de novo o que saiu. O que foi dispensado fica no estado do webview.
 */

interface VsCodeApi {
  postMessage(message: FromCozinha): void;
  getState(): { dispensadas?: DispensadasSalvas } | undefined;
  setState(state: { dispensadas: DispensadasSalvas }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();

const ANNOUNCE_EVERY_MS = 5_000;
const descarte = new Descarte({ saemAposMs: 0 }, vscode.getState()?.dispensadas ?? {});

const canvas = document.getElementById('cozinha') as HTMLCanvasElement;
const list = document.getElementById('ci-presentes') as HTMLUListElement;
const cards = document.getElementById('ci-telas') as HTMLDivElement;
const block = document.getElementById('cozinha-bloco') as HTMLDivElement;
const empty = document.getElementById('vazio') as HTMLDivElement;
const emptyText = document.getElementById('vazio-texto') as HTMLParagraphElement;
const notice = document.getElementById('aviso') as HTMLParagraphElement;
const live = document.getElementById('anuncio') as HTMLDivElement;
const clearButton = document.getElementById('limpar') as HTMLButtonElement;
const restoreButton = document.getElementById('restaurar') as HTMLButtonElement;
const refreshButton = document.getElementById('atualizar') as HTMLButtonElement;
const followButton = document.getElementById('acompanhar') as HTMLButtonElement;

function openRun(run: CiRun): void {
  vscode.postMessage({ type: 'abrir', repo: run.repo, id: run.id, url: run.url });
}

function save(): void {
  vscode.setState({ dispensadas: descarte.salvar() });
}

function dismiss(run: CiRun): void {
  descarte.dispensar(run);
  save();
  kitchen.refresh();
}

const kitchen = mountKitchen({
  canvas,
  onOpen: openRun,
  filter: (runs, now) => descarte.visiveis(runs, now),
  onChange: () => {
    render();
  },
});

const announcer = new RunAnnouncer({ minIntervalMs: ANNOUNCE_EVERY_MS });
let announceTimer: number | undefined;
let loaded = false;

function allKnown(): CiRun[] {
  return (kitchen.status?.repos ?? []).flatMap((repo) => [...repo.runs]);
}

function render(): void {
  const status = kitchen.status;
  const runs = kitchen.runs();
  const known = allKnown();
  const watching = status !== undefined && status.repos.length > 0;
  const hidden = descarte.quantasEscondidas(known);

  block.hidden = !watching;
  empty.hidden = watching && (runs.length > 0 || hidden > 0 || known.length > 0);
  if (!watching) {
    emptyText.textContent = l10n.t(
      'No repository is being followed. Open a folder with a GitHub origin or pick the repositories to follow.',
    );
    followButton.hidden = false;
  } else if (runs.length === 0 && known.length === 0) {
    emptyText.textContent = l10n.t('No runs yet.');
    followButton.hidden = true;
  }

  canvas.setAttribute(
    'aria-label',
    [
      describeKitchen(status) || l10n.t('CI kitchen'),
      runs.length === 0 ? l10n.t('No runs yet.') : '',
    ]
      .filter(Boolean)
      .join('. '),
  );
  renderKitchenList(list, runs, { onOpen: openRun });
  renderKitchenCards(cards, runs, { onOpen: openRun, onDismiss: dismiss });

  clearButton.disabled = !runs.some(
    (run) => run.estado !== 'trabalhando' && run.estado !== 'fila' && run.estado !== 'aguardando',
  );
  restoreButton.hidden = hidden === 0;
  restoreButton.textContent = l10n.t('Show removed ({0})', String(hidden));

  if (watching) {
    announcer.observe(runs);
    if (loaded) scheduleAnnouncement();
  }
}

function scheduleAnnouncement(): void {
  if (announceTimer !== undefined) return;
  const wait = announcer.waitMs(Date.now());
  if (wait === undefined) return;
  announceTimer = window.setTimeout(() => {
    announceTimer = undefined;
    const text = announcer.take(Date.now());
    if (text) live.textContent = text;
    scheduleAnnouncement();
  }, wait);
}

function setNotice(text: string): void {
  notice.textContent = text;
  notice.hidden = text === '';
}

clearButton.addEventListener('click', () => {
  descarte.limparConcluidas(kitchen.runs());
  save();
  kitchen.refresh();
});
restoreButton.addEventListener('click', () => {
  descarte.restaurar();
  save();
  kitchen.refresh();
});
refreshButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'atualizar' });
});
followButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'acompanhar' });
});

window.addEventListener('message', (event: MessageEvent<ToCozinha>) => {
  const message = event.data;
  switch (message.type) {
    case 'status':
      setNotice('');
      kitchen.setOffline(false);
      kitchen.apply(message.status);
      // O retrato é o ponto de partida: só as mudanças depois dele são anunciadas.
      loaded = true;
      descarte.podar(allKnown());
      save();
      return;
    case 'event':
      if (message.event.topic === 'ci.run') kitchen.onRun(message.event.data as CiRun);
      return;
    case 'config':
      descarte.saemAposMs = message.saemAposMin * 60_000;
      kitchen.refresh();
      return;
    case 'offline':
      kitchen.setOffline(true);
      setNotice(l10n.t('FaKL Core is not connected.'));
      return;
  }
});

render();
// A duração das execuções em andamento anda sozinha, e as concluídas saem quando passam do prazo.
window.setInterval(() => {
  kitchen.refresh();
}, 10_000);
vscode.postMessage({ type: 'ready' });
