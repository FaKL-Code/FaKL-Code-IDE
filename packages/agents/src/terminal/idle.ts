/**
 * Heurística de "a CLI terminou e espera uma mensagem" (ADR 0047). Não há
 * protocolo: um programa de terminal não diz que acabou. O adaptador considera
 * a CLI ociosa quando passam `silenceMs` sem nenhuma saída E, se o perfil
 * definiu `prompt`, a linha em andamento casa com ele. Pode errar nos dois
 * sentidos (uma CLI que pensa em silêncio parece ociosa; uma que pergunta algo
 * sem casar o prompt parece ocupada); por isso é configurável por perfil.
 */

export const DEFAULT_SILENCE_MS = 3_000;
/** A linha de prompt é curta; olhar só o fim limita o custo de uma regex lenta. */
const PROMPT_WINDOW = 400;

export interface IdleOptions {
  /** Expressão regular da linha de prompt; inválida é ignorada (só vale o silêncio). */
  readonly prompt?: string | undefined;
  readonly silenceMs?: number | undefined;
}

export function compilePrompt(source: string | undefined): RegExp | undefined {
  if (!source) return undefined;
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

export type IdleVerdict = 'ocioso' | 'executando';

export class IdleDetector {
  private readonly prompt: RegExp | undefined;
  private readonly silenceMs: number;
  private lastOutputAt: number | undefined;
  private current: IdleVerdict = 'executando';

  constructor(options: IdleOptions = {}) {
    this.prompt = compilePrompt(options.prompt);
    this.silenceMs = Math.max(100, options.silenceMs ?? DEFAULT_SILENCE_MS);
  }

  get state(): IdleVerdict {
    return this.current;
  }

  /** Saiu texto: a CLI está trabalhando. Devolve o novo estado quando ele muda. */
  output(now: number): IdleVerdict | undefined {
    this.lastOutputAt = now;
    return this.set('executando');
  }

  /** Algo foi digitado no terminal: a CLI vai responder, então conta como trabalhando. */
  input(now: number): IdleVerdict | undefined {
    return this.output(now);
  }

  /** O programa começou (ainda sem saída): o relógio do silêncio parte daqui. */
  started(now: number): void {
    this.lastOutputAt ??= now;
  }

  /** Chamado periodicamente com a linha em andamento; devolve o novo estado quando ele muda. */
  tick(now: number, currentLine: string): IdleVerdict | undefined {
    if (this.current === 'ocioso' || this.lastOutputAt === undefined) return undefined;
    if (now - this.lastOutputAt < this.silenceMs) return undefined;
    if (this.prompt && !this.prompt.test(currentLine.slice(-PROMPT_WINDOW))) return undefined;
    return this.set('ocioso');
  }

  private set(next: IdleVerdict): IdleVerdict | undefined {
    if (this.current === next) return undefined;
    this.current = next;
    return next;
  }
}
