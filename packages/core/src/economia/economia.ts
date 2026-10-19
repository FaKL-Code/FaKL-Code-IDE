import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localDay } from '../costs.js';
import { objectParams, RpcError, type Router } from '../rpc/router.js';
import { writeJsonAtomic } from '../store.js';
import { estimarTokens, isModoEconomia, MODOS_ECONOMIA, type ModoEconomia } from './compactar.js';

const SAVE_DELAY_MS = 1_000;
const FILE_VERSION = 1;
/** Dias de histórico guardados, para o gráfico e o total do mês. */
const RETENTION_DAYS = 90;

/** O que a economia fez, em números simples. */
export interface Contadores {
  /** Respostas de ferramentas que passaram pela compactação. */
  respostas: number;
  /** Caracteres a menos nas respostas compactadas. */
  caracteresCompactados: number;
  /** Leituras repetidas trocadas por um aviso curto. */
  repeticoes: number;
  caracteresRepeticoes: number;
  /** Tarefas distribuídas pelo roteador. */
  roteadas: number;
  /** Das roteadas, as que foram a um perfil mais barato que o de quem pediu. */
  rebaixadas: number;
  /** Diferença de custo médio por tarefa (placar) entre quem pediu e quem recebeu; só com dados dos dois. */
  usdEstimado: number;
}

const ZERO: Contadores = {
  respostas: 0,
  caracteresCompactados: 0,
  repeticoes: 0,
  caracteresRepeticoes: 0,
  roteadas: 0,
  rebaixadas: 0,
  usdEstimado: 0,
};

interface Documento {
  versao: number;
  desde: string;
  total: Contadores;
  dias: Record<string, Contadores>;
}

export interface EconomiaStatus {
  readonly modo: ModoEconomia;
  readonly desde: string;
  readonly total: Contadores & { tokensEstimados: number };
  readonly hoje: Contadores & { tokensEstimados: number };
  /** Aviso fixo: os tokens são estimados a partir de caracteres. */
  readonly nota: string;
}

export interface EconomiaOptions {
  readonly modo: () => ModoEconomia;
  readonly setModo: (modo: ModoEconomia) => Promise<void>;
  readonly dataDir?: string;
  readonly clock?: () => Date;
  readonly log?: (message: string) => void;
}

/** Soma `parcial` em `alvo`. */
function somar(alvo: Contadores, parcial: Partial<Contadores>): void {
  for (const chave of Object.keys(ZERO) as (keyof Contadores)[]) {
    alvo[chave] += parcial[chave] ?? 0;
  }
}

function comTokens(c: Contadores): Contadores & { tokensEstimados: number } {
  return {
    ...c,
    usdEstimado: Math.round(c.usdEstimado * 100) / 100,
    tokensEstimados: estimarTokens(c.caracteresCompactados + c.caracteresRepeticoes),
  };
}

function numero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? Math.min(valor, 50_000_000)
    : 0;
}

/**
 * Livro-caixa da economia de tokens (ADR 0052): o servidor MCP de cada agente
 * conta o que compactou e o que deixou de repetir e avisa o Core; o roteador
 * conta as tarefas distribuídas. Só somas, sem conteúdo de conversa.
 */
export class Economia {
  private doc: Documento;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly clock: () => Date;

  constructor(private readonly options: EconomiaOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.doc = this.vazio();
  }

  private vazio(): Documento {
    return {
      versao: FILE_VERSION,
      desde: localDay(this.clock()),
      total: { ...ZERO },
      dias: {},
    };
  }

  private get arquivo(): string | undefined {
    return this.options.dataDir ? join(this.options.dataDir, 'economia.json') : undefined;
  }

  async load(): Promise<void> {
    const arquivo = this.arquivo;
    if (!arquivo) return;
    try {
      const lido = JSON.parse(await readFile(arquivo, 'utf8')) as Documento;
      if (lido.versao === FILE_VERSION) this.doc = lido;
    } catch {
      // Sem arquivo ou ilegível: começa do zero.
    }
  }

  get modo(): ModoEconomia {
    return this.options.modo();
  }

  /** Soma ao total e ao dia de hoje. */
  registrar(parcial: Partial<Contadores>): void {
    const hoje = localDay(this.clock());
    const dia = (this.doc.dias[hoje] ??= { ...ZERO });
    somar(this.doc.total, parcial);
    somar(dia, parcial);
    if (Object.keys(this.doc.dias).length > RETENTION_DAYS) {
      this.doc.dias = Object.fromEntries(
        Object.entries(this.doc.dias)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-RETENTION_DAYS),
      );
    }
    this.dirty = true;
    this.schedule();
  }

  status(): EconomiaStatus {
    const hoje = this.doc.dias[localDay(this.clock())] ?? ZERO;
    return {
      modo: this.modo,
      desde: this.doc.desde,
      total: comTokens(this.doc.total),
      hoje: comTokens(hoje),
      nota: 'Tokens estimados a partir dos caracteres (4 por token); o custo em dólar só aparece quando o placar tem dados dos dois perfis.',
    };
  }

  async reset(): Promise<void> {
    this.doc = this.vazio();
    this.dirty = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer || !this.arquivo) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const arquivo = this.arquivo;
    if (!arquivo || !this.dirty) return;
    this.dirty = false;
    await writeJsonAtomic(arquivo, this.doc).catch((error: unknown) => {
      this.options.log?.(`economia: não gravou ${arquivo}: ${String(error)}`);
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  register(router: Router): void {
    router.register('economia.status', () => this.status());
    router.register('economia.setModo', async (params) => {
      const modo = objectParams(params).modo;
      if (!isModoEconomia(modo)) {
        throw RpcError.invalidParams(`modo deve ser ${MODOS_ECONOMIA.join(', ')}`);
      }
      await this.options.setModo(modo);
      return this.status();
    });
    // Chamado pelo servidor MCP do agente, com o token dele.
    router.register('economia.registrar', (params) => {
      const p = objectParams(params);
      this.registrar({
        respostas: Math.min(numero(p.respostas), 100_000),
        caracteresCompactados: numero(p.caracteresCompactados),
        repeticoes: Math.min(numero(p.repeticoes), 100_000),
        caracteresRepeticoes: numero(p.caracteresRepeticoes),
      });
      return null;
    });
    router.register('economia.reset', async () => {
      await this.reset();
      return null;
    });
  }
}
