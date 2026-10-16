import { l10n } from '@fakl/i18n';

/**
 * Enquadramento das mensagens no socket: um JSON por linha (NDJSON). JSON
 * serializado nunca contém quebra de linha literal, então `\n` separa
 * mensagens sem ambiguidade.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class LineDecoder {
  private buffer = '';

  constructor(private readonly maxBytes = MAX_MESSAGE_BYTES) {}

  /** Recebe um pedaço de dados e devolve as linhas completas. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    if (this.buffer.length > this.maxBytes) {
      this.buffer = '';
      throw new Error(l10n.t('Message larger than {0} bytes', this.maxBytes));
    }
    return lines.filter((line) => line.trim() !== '');
  }
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
