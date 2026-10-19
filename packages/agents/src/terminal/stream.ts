import { LineAssembler } from './ansi.js';
import { IdleDetector, type IdleOptions, type IdleVerdict } from './idle.js';

export interface StreamUpdate {
  /** Linhas fechadas desde a última chamada, sem escapes e sem linhas vazias. */
  readonly lines: readonly string[];
  /** Novo estado (heurística de ocioso), só quando mudou. */
  readonly state?: IdleVerdict;
}

/**
 * Extração de eventos do fluxo bruto de um terminal (ADR 0047): o texto que o
 * VS Code entrega vira linhas limpas e uma decisão ocioso/executando. É puro
 * (o relógio vem de fora), então roda nos testes sem VS Code.
 */
export class TerminalStream {
  private readonly assembler = new LineAssembler();
  private readonly idle: IdleDetector;

  constructor(options: IdleOptions = {}) {
    this.idle = new IdleDetector(options);
  }

  get state(): IdleVerdict {
    return this.idle.state;
  }

  /** A linha em andamento, para a extensão e os testes. */
  get partial(): string {
    return this.assembler.partial;
  }

  start(now: number): void {
    this.idle.started(now);
  }

  /** Digitaram no terminal: a CLI está para responder. */
  input(now: number): IdleVerdict | undefined {
    return this.idle.input(now);
  }

  push(chunk: string, now: number): StreamUpdate {
    const before = this.assembler.partial;
    const lines = this.assembler.push(chunk).filter((line) => line.trim() !== '');
    const changed = lines.length > 0 || this.assembler.partial !== before;
    const state = changed ? this.idle.output(now) : undefined;
    return { lines, ...(state ? { state } : {}) };
  }

  /**
   * Passagem do tempo. Quando a heurística diz "ocioso", a linha em andamento
   * (normalmente o prompt) fecha e sai junto, para o Core ver como a CLI terminou.
   */
  tick(now: number): StreamUpdate {
    const state = this.idle.tick(now, this.assembler.partial);
    if (!state) return { lines: [] };
    const last = this.assembler.flush();
    return { lines: last ? [last] : [], state };
  }

  /** O processo terminou: o que sobrou na linha em andamento sai. */
  end(): StreamUpdate {
    const last = this.assembler.flush();
    return { lines: last ? [last] : [] };
  }
}
