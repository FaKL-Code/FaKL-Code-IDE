import type { CiRun, CiState } from '@fakl/protocol';

import { runKey } from './cozinha-model.js';

/*
 * O que sai da cozinha do CI, como o agente que termina e sai do café ou some da
 * Mesa com "Limpar encerrados". Só lógica: quem guarda o estado é a tela.
 *
 * - Dispensar uma execução a esconde enquanto o estado dela for o de quando foi
 *   dispensada. Se ela muda (alguém reexecuta, uma falha vira sucesso), volta.
 * - Sucesso e cancelada saem sozinhas depois de `saemAposMs`; falha fica até ser
 *   dispensada ou substituída por uma execução mais nova do mesmo fluxo, porque é
 *   o que pede atenção.
 */

const FINAIS: ReadonlySet<CiState> = new Set<CiState>(['sucesso', 'falha', 'cancelada']);
const SAEM_SOZINHAS: ReadonlySet<CiState> = new Set<CiState>(['sucesso', 'cancelada']);

/** A execução terminou (não está na fila, rodando nem esperando aprovação). */
export function terminou(run: Pick<CiRun, 'estado'>): boolean {
  return FINAIS.has(run.estado);
}

/** Dispensadas como `{ chave da execução: estado de quando saiu }`, para guardar no estado do webview. */
export type DispensadasSalvas = Readonly<Record<string, CiState>>;

export interface DescarteOptions {
  /** Depois de quanto tempo uma execução com sucesso ou cancelada sai sozinha; 0 desliga. */
  readonly saemAposMs: number;
}

export class Descarte {
  private readonly dispensadas = new Map<string, CiState>();
  saemAposMs: number;
  /** Mostrar também as que passaram do prazo (quem pediu "mostrar as removidas"). */
  ignorarPrazo = false;

  constructor(options: DescarteOptions, salvas: DispensadasSalvas = {}) {
    this.saemAposMs = options.saemAposMs;
    for (const [key, estado] of Object.entries(salvas)) this.dispensadas.set(key, estado);
  }

  /** Esconde uma execução até o estado dela mudar. */
  dispensar(run: CiRun): void {
    this.dispensadas.set(runKey(run), run.estado);
  }

  /** Esconde todas as que já terminaram; devolve quantas. */
  limparConcluidas(runs: readonly CiRun[]): number {
    let count = 0;
    for (const run of runs) {
      if (terminou(run) && !this.escondida(run)) {
        this.dispensar(run);
        count++;
      }
    }
    return count;
  }

  /** Traz de volta tudo o que foi dispensado e as que passaram do prazo. */
  restaurar(): void {
    this.dispensadas.clear();
    this.ignorarPrazo = true;
  }

  /** Foi dispensada (e continua no estado de quando foi). */
  escondida(run: CiRun): boolean {
    return this.dispensadas.get(runKey(run)) === run.estado;
  }

  /** Quantas das execuções dadas estão escondidas por dispensa (sem contar as que saíram sozinhas). */
  quantasEscondidas(runs: readonly CiRun[]): number {
    return runs.filter((run) => this.escondida(run)).length;
  }

  /** O que fica na cozinha: sem as dispensadas e sem as que já passaram do tempo. */
  visiveis(runs: readonly CiRun[], now: number): CiRun[] {
    return runs.filter((run) => !this.escondida(run) && !this.expirou(run, now));
  }

  /** Quantas das execuções dadas estão fora da tela, por dispensa ou por prazo. */
  quantasForaDaTela(runs: readonly CiRun[], now: number): number {
    return runs.length - this.visiveis(runs, now).length;
  }

  /** Sucesso ou cancelada há mais de `saemAposMs`. */
  expirou(run: CiRun, now: number): boolean {
    if (this.ignorarPrazo || this.saemAposMs <= 0 || !SAEM_SOZINHAS.has(run.estado)) return false;
    const fim = Date.parse(run.fim ?? run.inicio);
    return Number.isFinite(fim) && now - fim >= this.saemAposMs;
  }

  /** Tira as entradas de execuções que não existem mais, para o estado guardado não crescer sem fim. */
  podar(runs: readonly CiRun[]): void {
    const vivas = new Set(runs.map(runKey));
    for (const key of this.dispensadas.keys()) if (!vivas.has(key)) this.dispensadas.delete(key);
  }

  salvar(): DispensadasSalvas {
    return Object.fromEntries(this.dispensadas);
  }
}
