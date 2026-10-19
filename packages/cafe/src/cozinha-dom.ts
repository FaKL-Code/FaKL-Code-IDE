import { l10n } from '@fakl/i18n';
import type { CiRun } from '@fakl/protocol';

import { ciStateText, describeRun, formatSeconds, runKey, runSeconds } from './cozinha-model.js';

/*
 * DOM da cozinha do CI, comum ao painel da IDE e ao app do celular: a faixa de
 * cartões (a miniatura de cada execução, com nome do workflow, branch, duração
 * e jobs) e a lista escondida para teclado e leitor de tela. Os dois só
 * mexem no DOM se o texto mudou, e devolvem o foco ao item que o tinha.
 */

export interface KitchenDomOptions {
  readonly onOpen: (run: CiRun) => void;
  /** Quando dado, cada cartão ganha um botão para tirar a execução da tela. */
  readonly onDismiss?: (run: CiRun) => void;
  readonly now?: number;
}

function keepFocus(container: HTMLElement, rebuild: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && container.contains(active) ? active.dataset.run : undefined;
  rebuild();
  if (key) container.querySelector<HTMLElement>(`[data-run="${CSS.escape(key)}"]`)?.focus();
}

function signature(runs: readonly CiRun[], now: number): string {
  return runs.map((run) => `${runKey(run)}|${describeRun(run, now)}`).join('||');
}

/** Símbolo curto de um job; o estado também vai por extenso no `title`. */
const JOB_MARK: Record<string, string> = {
  fila: '..',
  trabalhando: '>>',
  aguardando: '??',
  sucesso: 'ok',
  falha: 'xx',
  cancelada: '--',
};

/** Faixa de cartões: uma miniatura por execução na bancada. */
export function renderKitchenCards(
  container: HTMLElement,
  runs: readonly CiRun[],
  options: KitchenDomOptions,
): void {
  const now = options.now ?? Date.now();
  const sig = signature(runs, now);
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  keepFocus(container, () => {
    container.replaceChildren(
      ...runs.map((run) => {
        const card = document.createElement('article');
        card.className = 'ci-tela';
        card.setAttribute('role', 'listitem');
        card.dataset.estado = run.estado;
        const head = document.createElement('div');
        head.className = 'ci-cabeca';
        const name = document.createElement('strong');
        name.textContent = run.nome;
        const state = document.createElement('span');
        state.textContent = ciStateText(run.estado);
        head.append(name, state);
        const title = document.createElement('div');
        title.className = 'ci-titulo';
        title.textContent = run.branch ? `${run.repo} - ${run.branch}` : run.repo;
        const time = document.createElement('div');
        time.className = 'ci-duracao';
        time.textContent = formatSeconds(runSeconds(run, now));
        const jobs = document.createElement('ul');
        jobs.className = 'ci-jobs';
        for (const job of run.jobs) {
          const item = document.createElement('li');
          item.dataset.estado = job.estado;
          item.title = `${job.nome}: ${ciStateText(job.estado)}`;
          item.textContent = `${JOB_MARK[job.estado] ?? ''} ${job.nome}`;
          jobs.append(item);
        }
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'ci-abrir';
        open.dataset.run = `card:${runKey(run)}`;
        open.title = l10n.t('Open this CI run');
        open.append(head, title, time, jobs);
        open.addEventListener('click', () => {
          options.onOpen(run);
        });
        card.append(open);
        if (options.onDismiss) {
          const dismiss = document.createElement('button');
          dismiss.type = 'button';
          dismiss.className = 'ci-dispensar';
          dismiss.dataset.run = `dispensar:${runKey(run)}`;
          dismiss.textContent = 'x';
          dismiss.title = l10n.t('Remove this run from the kitchen');
          dismiss.setAttribute(
            'aria-label',
            l10n.t('Remove the run {0} from the kitchen', describeRun(run, now)),
          );
          dismiss.addEventListener('click', () => {
            options.onDismiss?.(run);
          });
          card.append(dismiss);
        }
        return card;
      }),
    );
  });
  container.hidden = runs.length === 0;
}

/** Lista escondida (só leitor de tela e teclado): uma linha por execução. */
export function renderKitchenList(
  list: HTMLElement,
  runs: readonly CiRun[],
  options: KitchenDomOptions,
): void {
  const now = options.now ?? Date.now();
  const sig = signature(runs, now);
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  keepFocus(list, () => {
    list.replaceChildren(
      ...runs.map((run) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.run = `lista:${runKey(run)}`;
        button.textContent = describeRun(run, now);
        button.title = l10n.t('Open this CI run');
        // Enter e Espaço já ativam o botão e disparam o `click`.
        button.addEventListener('click', () => {
          options.onOpen(run);
        });
        item.append(button);
        return item;
      }),
    );
  });
}
