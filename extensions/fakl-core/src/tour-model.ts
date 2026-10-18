/**
 * Tour da FaKL-Code: as dicas dentro das telas, a pasta de exemplo da primeira
 * tarefa e os passos do walkthrough nativo. Funções puras, sem VS Code. O que
 * a pessoa já viu vai no mesmo progresso da jornada de configuração
 * ({@link SetupProgress}, no globalState), não num armazenamento à parte.
 *
 * A extensão não desenha sobre a interface nativa do VS Code (barra lateral,
 * abas): o tour usa o walkthrough nativo e balões só nas nossas webviews
 * (ADR 0040).
 */

import { l10n } from '@fakl/i18n';
import type { AgentProfileAvailability } from '@fakl/protocol';

import type { SetupProgress } from './setup-model.js';
import type { TipView, TourSurface, TourTip } from './tour-protocol.js';

/**
 * Passos do walkthrough `fakl.tour`: o id do passo e o comando que ele abre.
 * O package.json declara os mesmos passos; um teste confere que não divergem.
 */
export const TOUR_STEPS: readonly { readonly id: string; readonly comando: string }[] = [
  { id: 'doctor', comando: 'fakl.doctor.open' },
  { id: 'mesa', comando: 'fakl.mesa.open' },
  { id: 'chat', comando: 'fakl.chat.open' },
  { id: 'cafe', comando: 'fakl.cafe.open' },
  { id: 'vault', comando: 'fakl.vault.graph' },
  { id: 'github', comando: 'fakl.github.openFull' },
  { id: 'celular', comando: 'fakl.remote.configure' },
  { id: 'primeira', comando: 'fakl.tour.firstTask' },
];

/** Id do walkthrough no formato que `workbench.action.openWalkthrough` pede. */
export const TOUR_WALKTHROUGH = 'fakl.fakl-core#fakl.tour';

/** Os balões, montados a cada chamada porque o idioma só é escolhido depois de carregar o módulo. */
export function tourTips(): TourTip[] {
  return [
    {
      id: 'mesa.cartoes',
      superficie: 'mesa',
      alvo: '.toolbar',
      texto: l10n.t(
        'This is the Desk. Every card is an agent, a task or a note. Use these tools to add one, and drag cards to arrange them.',
      ),
    },
    {
      id: 'chat.escrever',
      superficie: 'chat',
      alvo: 'textarea',
      texto: l10n.t(
        'Describe what you want done. The agent works on its own branch, so your files stay as they are until you accept the changes.',
      ),
    },
    {
      id: 'cafe.agente',
      superficie: 'cafe',
      alvo: '#novo-agente',
      texto: l10n.t(
        'Start an agent here. It sits down at a computer in the café and you can watch it work.',
      ),
    },
    {
      id: 'vault.grafo',
      superficie: 'vault',
      alvo: '#filtro',
      texto: l10n.t(
        'Each dot is a note and each line is a link between two notes. Type here to find one.',
      ),
    },
  ];
}

/** Dicas ainda não vistas de uma tela; nenhuma se a pessoa as desligou. */
export function pendingTips(surface: TourSurface, progress: SetupProgress): TipView[] {
  if (progress.dicasDesligadas) return [];
  const seen = new Set(progress.dicasVistas ?? []);
  return tourTips()
    .filter((tip) => tip.superficie === surface && !seen.has(tip.id))
    .map(({ id, alvo, texto }) => ({ id, alvo, texto }));
}

/** Marca uma dica como vista, só se ela existe; sem repetir ids. */
export function withTipSeen(progress: SetupProgress, id: string): SetupProgress {
  if (!tourTips().some((tip) => tip.id === id)) return progress;
  return { ...progress, dicasVistas: [...new Set([...(progress.dicasVistas ?? []), id])] };
}

export function withTipsOff(progress: SetupProgress): SetupProgress {
  return { ...progress, dicasDesligadas: true };
}

/** "Mostrar as dicas de novo": limpa o que foi visto e religa as dicas. */
export function withTipsReset(progress: SetupProgress): SetupProgress {
  return {
    puladas: progress.puladas,
    feitas: progress.feitas,
    ...(progress.interesses ? { interesses: progress.interesses } : {}),
  };
}

/** Um arquivo da pasta de exemplo da primeira tarefa. */
export interface SampleFile {
  readonly nome: string;
  readonly conteudo: string;
}

export function sampleFiles(): SampleFile[] {
  return [
    {
      nome: 'README.md',
      conteudo: `${l10n.t('# Sample project')}\n\n${l10n.t(
        'This folder was created by the FaKL-Code tour. It has no real work in it: it is a safe place for a first agent.',
      )}\n\n${l10n.t('The project is a tiny to-do list kept in a text file.')}\n`,
    },
    {
      nome: 'todo.txt',
      conteudo: `${l10n.t('Buy coffee')}\n${l10n.t('Write the first note')}\n${l10n.t('Try the Desk')}\n`,
    },
  ];
}

/** O pedido da primeira tarefa: só lê, para a Mesa e o café mostrarem o agente trabalhando sem mexer em nada. */
export function sampleTask(): string {
  return l10n.t(
    'Read README.md and todo.txt in this folder and tell me, in two short sentences, what this project is. Do not change any file.',
  );
}

/** O agente da primeira tarefa: o primeiro pronto na ordem dada (a do Core, que põe o Claude na frente). */
export function pickSampleProfile(
  profiles: readonly AgentProfileAvailability[],
): AgentProfileAvailability | undefined {
  return profiles.find((profile) => profile.availability.status === 'pronto');
}
