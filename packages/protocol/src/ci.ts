/** Café do CI (SDD 13.7, ADR 0051): as execuções do GitHub Actions como a cozinha do café. */

/**
 * Estado de uma execução ou de um job, já traduzido do par `status` e
 * `conclusion` do GitHub. `aguardando` é a espera por aprovação (ambiente
 * protegido ou revisão manual); `fila` é só esperar um executor livre.
 */
export type CiState = 'fila' | 'trabalhando' | 'aguardando' | 'sucesso' | 'falha' | 'cancelada';

/** Um job de uma execução: uma estação (xícara) da bancada. */
export interface CiJob {
  readonly id: number;
  readonly nome: string;
  readonly estado: CiState;
  readonly inicio?: string;
  readonly fim?: string;
}

/** Uma execução (workflow run): um cozinheiro na bancada. */
export interface CiRun {
  /** `dono/nome` do repositório. */
  readonly repo: string;
  readonly id: number;
  readonly numero: number;
  /** Nome do workflow (ou o título da execução, se o workflow não tem nome). */
  readonly nome: string;
  readonly branch?: string;
  readonly evento: string;
  readonly estado: CiState;
  readonly url: string;
  /** ISO 8601: quando a execução foi criada. */
  readonly inicio: string;
  /** ISO 8601: última atualização; para uma execução terminada, é o fim. */
  readonly fim?: string;
  readonly jobs: readonly CiJob[];
}

/** Evento `ci.run`: uma execução apareceu ou mudou de estado (ou de estado de algum job). */
export type CiRunEventData = CiRun;

/** Os repositórios acompanhados e o que se sabe deles. */
export interface CiRepoStatus {
  readonly repo: string;
  /** `aberto`: o repositório da pasta aberta na IDE. `marcado`: escolhido pelo usuário. */
  readonly origem: 'aberto' | 'marcado';
  readonly runs: readonly CiRun[];
  readonly erro?: string;
}

/** `ci.status`. */
export interface CiStatus {
  /** O usuário conectou a conta do GitHub; sem isso nada é consultado. */
  readonly conectado: boolean;
  /** As consultas automáticas estão ligadas (`fakl.rede.consultasAutomaticas`). */
  readonly automatico: boolean;
  readonly repos: readonly CiRepoStatus[];
  /** Repositórios pedidos que passaram do limite e não são acompanhados. */
  readonly descartados: readonly string[];
  /** Fluxos cuja execução mais recente, por branch, falhou. */
  readonly falhando: number;
  /** Execuções em andamento agora. */
  readonly trabalhando: number;
  /** Execuções concluídas com sucesso seguidas, da mais nova para trás (janela consultada). */
  readonly verdesSeguidos: number;
  /** ISO 8601 da última consulta que terminou. */
  readonly atualizadoEm?: string;
}

/** Parâmetros de `ci.status`. */
export interface CiStatusParams {
  /** Consulta o GitHub agora (pedido do usuário, vale mesmo com o interruptor desligado). */
  readonly atualizar?: boolean;
}

/** Parâmetros de `ci.watch.set`: quem a IDE quer acompanhar. */
export interface CiWatchSetParams {
  /** Repositórios marcados pelo usuário, `dono/nome`. */
  readonly repos?: readonly string[];
  /** Pastas abertas na IDE; o Core descobre o repositório do `origin` de cada uma. */
  readonly pastas?: readonly string[];
  /** Valor atual de `fakl.rede.consultasAutomaticas`. */
  readonly automatico?: boolean;
}
