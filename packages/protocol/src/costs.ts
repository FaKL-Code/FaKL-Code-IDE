/** Um trecho de gasto de uma sessão de agente (SDD 7, CostEntry). */
export interface CostEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly provedor: string;
  readonly modelo?: string;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  /** Só quando o agente informa o custo em dólares. */
  readonly custoUsd: number;
  readonly ts: string;
  /** Tarefa a que a sessão pertence, quando é parte de uma execução. */
  readonly taskId?: string;
}

export interface CostTotals {
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly custoUsd: number;
}

/** Teto diário de um provedor (RNF-13); sem valor, não há teto. */
export interface DailyCap {
  readonly custoUsd?: number;
  readonly tokens?: number;
}

/** `costs.summary`: o gasto de um dia, por provedor e por sessão. */
export interface CostSummary {
  /** Dia no fuso local, AAAA-MM-DD. */
  readonly dia: string;
  readonly total: CostTotals;
  readonly porProvedor: Readonly<Record<string, CostTotals>>;
  readonly porSessao: Readonly<Record<string, CostTotals>>;
  readonly tetos: Readonly<Record<string, DailyCap>>;
  /** Provedores que bateram o teto hoje. */
  readonly bloqueados: readonly string[];
}

/** `costs.byTask`: o gasto acumulado de cada tarefa. */
export type CostByTask = Readonly<Record<string, CostTotals>>;

/** Dados do evento `run.limit` quando é o teto diário de um provedor que estourou. */
export interface DailyCapEventData {
  readonly tipo: 'teto-diario';
  readonly provedor: string;
  readonly limite: 'custoUsd' | 'tokens';
  readonly valor: number;
  readonly gasto: number;
  /** Sessões pausadas por causa do teto. */
  readonly pausadas: readonly string[];
}

/** Uma janela de plano: quanto foi usado e quando ela fecha (ADR 0026). */
export interface UsageWindow {
  readonly tokens?: number;
  /** Respostas do modelo na janela; a cota do Gemini é por requisições. */
  readonly requisicoes?: number;
  /** Só com percentual real do provedor ou teto informado. */
  readonly fracao?: number;
  /** Epoch ms em que a janela zera. */
  readonly resetaEm?: number;
}

/** A sessão de 5 horas, o dia e a semana de um provedor ou conta. */
export interface ProviderWindows {
  readonly provedor: string;
  /** Nome mostrado, como o apelido de uma conta. */
  readonly nome?: string;
  readonly sessao?: UsageWindow;
  /** Cota diária (Gemini: zera à meia-noite do Pacífico). */
  readonly dia?: UsageWindow;
  readonly semana?: UsageWindow;
  /** `real`: percentual do provedor; `estimado`: somado dos tokens locais. */
  readonly origem: 'real' | 'estimado';
  /** Provedor configurado sem registro de uso local: a interface mostra "sem dados". */
  readonly semDados?: boolean;
}

/** `usage.windows`. */
export interface UsageWindowsResult {
  readonly janelas: readonly ProviderWindows[];
}
