import {
  describeKitchen,
  Descarte,
  kitchenRuns,
  mountKitchen,
  RunAnnouncer,
  renderKitchenCards,
  renderKitchenList,
  terminou,
  type DispensadasSalvas,
} from '@fakl/cafe';
import { l10n, useLocale } from '@fakl/i18n';
import type { CiRun } from '@fakl/protocol';

import type { FromCozinha, ToCozinha } from '../ci-panel-protocol.js';

/*
 * Cozinha do CI em tela própria (ADR 0053). De cima para baixo: o placar, a
 * cozinha em pixel art ampliada, e os cartões em três grupos (precisa de
 * atenção, rodando, concluídas). As saídas para o que já passou são as do café
 * e da Mesa: o x do cartão, "Limpar concluídas" e "Mostrar as removidas".
 * O que foi dispensado fica no estado do webview.
 */

interface VsCodeApi {
  postMessage(message: FromCozinha): void;
  getState(): { dispensadas?: DispensadasSalvas } | undefined;
  setState(state: { dispensadas: DispensadasSalvas }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();

/** O elemento do HTML da tela, que o `ci-panel.ts` sempre monta; sem ele a tela está quebrada. */
function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`cozinha: falta #${id}`);
  return found;
}

const ANNOUNCE_EVERY_MS = 5_000;
/** Quantas execuções os cartões mostram, ao todo (a cozinha em pixel mostra 8). */
const CARDS_MAX = 40;
const descarte = new Descarte({ saemAposMs: 0 }, vscode.getState()?.dispensadas ?? {});

const canvas = el('cozinha') as HTMLCanvasElement;
const block = el('cozinha-bloco');
const list = el('ci-presentes') as HTMLUListElement;
const summary = el('resumo');
const empty = el('vazio') as HTMLDivElement;
const emptyText = el('vazio-texto') as HTMLParagraphElement;
const notice = el('aviso') as HTMLParagraphElement;
const live = el('anuncio') as HTMLDivElement;
const clearButton = el('limpar') as HTMLButtonElement;
const restoreButton = el('restaurar') as HTMLButtonElement;
const refreshButton = el('atualizar') as HTMLButtonElement;
const followButton = el('acompanhar') as HTMLButtonElement;

function attention(run: CiRun): boolean {
  return run.estado === 'falha' || run.estado === 'aguardando';
}
function running(run: CiRun): boolean {
  return run.estado === 'trabalhando' || run.estado === 'fila';
}
function finished(run: CiRun): boolean {
  return run.estado === 'sucesso' || run.estado === 'cancelada';
}

const GROUPS = [
  { section: 'sec-atencao', cards: 'ci-atencao', count: 'n-atencao', match: attention },
  { section: 'sec-andamento', cards: 'ci-andamento', count: 'n-andamento', match: running },
  { section: 'sec-concluidas', cards: 'ci-concluidas', count: 'n-concluidas', match: finished },
].map((group) => ({
  match: group.match,
  section: el(group.section),
  cards: el(group.cards) as HTMLDivElement,
  count: el(group.count),
}));

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

/** O que está na tela: sem as dispensadas e as vencidas, a mais recente de cada fluxo. */
function onScreenRuns(now: number): CiRun[] {
  return kitchenRuns(descarte.visiveis(allKnown(), now), now, CARDS_MAX);
}

/** Altura máxima da cozinha em pixel, para os cartões aparecerem logo abaixo na primeira tela. */
const KITCHEN_MAX_HEIGHT = 420;

/** A cozinha em pixel, ampliada em número inteiro de vezes: cabe na largura e não passa da altura máxima. */
function fitCanvas(): void {
  const room = Math.max(1, block.clientWidth - 24);
  const byWidth = Math.floor(room / Math.max(1, canvas.width));
  const byHeight = Math.max(2, Math.floor(KITCHEN_MAX_HEIGHT / Math.max(1, canvas.height)));
  const scale = Math.max(1, Math.min(5, byWidth, byHeight));
  canvas.style.width = `${String(canvas.width * scale)}px`;
  canvas.style.height = `${String(canvas.height * scale)}px`;
}

function setTile(id: string, value: number): void {
  const tile = el(id);
  const strong = tile.querySelector('strong');
  if (strong) strong.textContent = String(value);
  tile.dataset.ativo = value > 0 ? 'sim' : 'nao';
}

function render(): void {
  const now = Date.now();
  const status = kitchen.status;
  const known = allKnown();
  const watching = status !== undefined && status.repos.length > 0;
  const onScreen = onScreenRuns(now);
  const bench = kitchen.runs();
  const away = descarte.quantasForaDaTela(known, now);

  summary.hidden = !watching;
  if (status && watching) {
    setTile('t-verdes', status.verdesSeguidos);
    setTile('t-falhando', status.falhando);
    setTile('t-andamento', status.trabalhando);
    el('repos').textContent = l10n.t('Following: {0}', status.repos.map((r) => r.repo).join(', '));
  }

  block.hidden = bench.length === 0;
  if (!block.hidden) fitCanvas();
  canvas.setAttribute(
    'aria-label',
    [
      describeKitchen(status) || l10n.t('CI kitchen'),
      bench.length === 0 ? l10n.t('No runs yet.') : '',
    ]
      .filter(Boolean)
      .join('. '),
  );
  renderKitchenList(list, bench, { onOpen: openRun });

  for (const group of GROUPS) {
    const runs = onScreen.filter(group.match);
    renderKitchenCards(group.cards, runs, { onOpen: openRun, onDismiss: dismiss });
    group.section.hidden = runs.length === 0;
    group.count.textContent = runs.length > 0 ? `(${String(runs.length)})` : '';
  }

  const nothing = onScreen.length === 0;
  empty.hidden = !nothing;
  if (nothing) {
    if (!watching) {
      emptyText.textContent = l10n.t(
        'No repository is being followed. Open a folder with a GitHub origin or pick the repositories to follow.',
      );
    } else if (away > 0) {
      emptyText.textContent = l10n.t(
        'No recent runs on the screen. {0} left on their own or were removed; use "Show removed" to see them.',
        String(away),
      );
    } else {
      emptyText.textContent = l10n.t('No runs yet.');
    }
    followButton.hidden = watching;
  }

  clearButton.disabled = !onScreen.some(terminou);
  restoreButton.hidden = away === 0;
  restoreButton.textContent = l10n.t('Show removed ({0})', String(away));

  if (watching) {
    announcer.observe(bench);
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
  descarte.limparConcluidas(onScreenRuns(Date.now()));
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
window.addEventListener('resize', () => {
  if (!block.hidden) fitCanvas();
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
// A duração e o "há quanto tempo" andam sozinhos, e as concluídas saem quando passam do prazo.
window.setInterval(() => {
  kitchen.refresh();
}, 10_000);
vscode.postMessage({ type: 'ready' });
