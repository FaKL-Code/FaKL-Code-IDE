import { l10n } from '@fakl/i18n';
import type {
  AgentTerminalAttachResult,
  AgentTerminalLine,
  AgentTerminalLinesParams,
} from '@fakl/protocol';

const GRAY = '\u001b[90m';
const RESET = '\u001b[0m';

/** Linhas do Core viram texto de terminal: o Pseudoterminal precisa de CRLF. */
export function terminalText(lines: readonly AgentTerminalLine[]): string {
  return lines.map((line) => `${line.text}\r\n`).join('');
}

/** O aviso que abre o terminal: ele só mostra o que o agente faz. */
export function readOnlyNotice(): string {
  return `${GRAY}${l10n.t(
    'Read-only terminal: it shows what the agent does, live. Keys are ignored; use the chat to talk to the agent.',
  )}${RESET}\r\n`;
}

/** Nome da aba de um agente; sessões com o mesmo nome ganham o fim do id. */
export function terminalTitle(nome: string, sessionId: string, taken: ReadonlySet<string>): string {
  const base = l10n.t('Terminal: {0}', nome);
  return taken.has(base) ? `${base} (${sessionId.slice(-6)})` : base;
}

/**
 * Junta o histórico e as notificações de um terminal anexado, sem repetir nem
 * perder linha. Notificações que chegam antes da resposta do `attach` esperam
 * por ela; quem reconecta só recebe o que ainda não mostrou.
 */
export class TerminalFeed {
  private lastSeq = 0;
  private ready = false;
  private queued: AgentTerminalLinesParams[] = [];
  /** Estado do agente na última linha recebida. */
  state: AgentTerminalLinesParams['state'] | undefined;

  /** Um novo `attach` vai começar (primeiro ou depois de reconectar). */
  begin(): void {
    this.ready = false;
    this.queued = [];
  }

  /** Resposta do `attach`; devolve o texto a escrever, mais o que chegou enquanto esperava. */
  history(result: AgentTerminalAttachResult): string {
    this.state = result.state;
    const last = result.lines.at(-1)?.seq ?? 0;
    // O Core reiniciou: a numeração recomeçou e tudo é novo.
    if (last < this.lastSeq) this.lastSeq = 0;
    let out = '';
    if (this.lastSeq === 0 && result.dropped > 0) {
      out += `${GRAY}${l10n.t('({0} earlier lines are no longer kept)', String(result.dropped))}${RESET}\r\n`;
    }
    out += this.take(result.lines);
    this.ready = true;
    for (const params of this.queued) out += this.take(params.lines, params.state);
    this.queued = [];
    return out;
  }

  /** Notificação de linhas novas; devolve o texto a escrever agora (vazio se ainda não dá). */
  push(params: AgentTerminalLinesParams): string {
    if (!this.ready) {
      this.queued.push(params);
      return '';
    }
    return this.take(params.lines, params.state);
  }

  private take(
    lines: readonly AgentTerminalLine[],
    state?: AgentTerminalLinesParams['state'],
  ): string {
    if (state) this.state = state;
    const fresh = lines.filter((line) => line.seq > this.lastSeq);
    const last = fresh.at(-1);
    if (last) this.lastSeq = last.seq;
    return terminalText(fresh);
  }
}
