import { l10n } from '@fakl/i18n';
import {
  CoreNotifications,
  isFinalAgentState,
  type AgentOutputEventData,
  type AgentPermissionEventData,
  type AgentState,
  type AgentStateEventData,
  type AgentTerminalAttachResult,
  type AgentTerminalLine,
  type AgentTerminalLinesParams,
  type AgentToolEventData,
  type FaklEvent,
} from '@fakl/protocol';

import type { Disposable, EventBus } from './events/bus.js';
import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from './rpc/router.js';

/** Linhas guardadas por sessão (SDD 8.4). */
export const TERMINAL_MAX_LINES = 10_000;
/** Uma linha mais longa que isto é quebrada, para um agente sem quebra de linha não encher a memória. */
const LINE_MAX_CHARS = 2_000;
/** Argumentos de ferramenta e títulos: só o começo, o suficiente para saber o que foi. */
const SHORT_MAX_CHARS = 200;
/** Linhas do detalhe de um pedido de permissão e do prompt mostradas no terminal. */
const DETAIL_MAX_LINES = 8;
/** Ferramentas lembradas por sessão para não repetir a mesma linha a cada atualização de status. */
const TOOLS_MAX = 500;

const RESET = '\u001b[0m';
const GRAY = '\u001b[90m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const BLUE = '\u001b[34m';
const CYAN = '\u001b[36m';

const TOPICS = [
  'agent.output',
  'agent.tool',
  'agent.permission',
  'agent.answer',
  'agent.state',
  'agent.prompt',
  'agent.file',
] as const;

type OutputKind = AgentOutputEventData['kind'];

interface SessionBuffer {
  lines: AgentTerminalLine[];
  nextSeq: number;
  dropped: number;
  state: AgentState;
  /** Texto de saída ainda sem quebra de linha, do tipo `kind`. */
  partial: { kind: OutputKind; text: string } | undefined;
  /** Última linha emitida por ferramenta, para só mostrar quando algo muda. */
  tools: Map<string, string>;
  /** Título dos pedidos de permissão sem resposta, para a linha da decisão. */
  asking: Map<string, string>;
  clients: Map<string, CallContext>;
}

export interface AgentTerminalsOptions {
  /** Tira segredos do texto antes de ele entrar no buffer (SDD 14.1). */
  readonly redact?: (text: string) => string;
  /** Diz se a sessão existe (rodando ou guardada em disco); `attach` recusa as que não. */
  readonly exists?: (sessionId: string) => boolean;
  readonly capacity?: number;
}

/** Tira o que um agente poderia usar para mexer no terminal: escapes e controles. */
export function sanitizeTerminalText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  );
}

function short(text: string, max = SHORT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Terminal de leitura de cada agente (ADR 0046). Não há PTY: os agentes falam
 * ACP e não um terminal. Os eventos que o AgentRuntime já publica viram linhas
 * de terminal (com cores ANSI simples) num buffer circular por sessão, e quem
 * anexa recebe o histórico e depois as linhas novas.
 */
export class AgentTerminals {
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly subscription: Disposable;
  private readonly capacity: number;

  constructor(
    bus: EventBus,
    private readonly options: AgentTerminalsOptions = {},
  ) {
    this.capacity = options.capacity ?? TERMINAL_MAX_LINES;
    this.subscription = bus.subscribe(TOPICS, (event) => {
      this.onEvent(event);
    });
  }

  register(router: Router): void {
    router.register('agents.terminal.attach', (params, context) =>
      this.attach(stringParam(objectParams(params), 'sessionId'), context),
    );
    router.register('agents.terminal.detach', (params, context) => {
      this.detach(stringParam(objectParams(params), 'sessionId'), context);
      return null;
    });
  }

  /** Entrega o histórico e passa a notificar `context` das linhas novas, até `detach`. */
  attach(sessionId: string, context: CallContext): AgentTerminalAttachResult {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      if (!this.options.exists?.(sessionId)) {
        throw RpcError.notFound(l10n.t('session {0} does not exist', sessionId));
      }
      buffer = this.create(sessionId);
    }
    // O que ainda está sem quebra de linha aparece junto com o histórico.
    this.flushPartial(buffer, sessionId);
    if (!buffer.clients.has(context.connectionId)) {
      buffer.clients.set(context.connectionId, context);
      context.onClose(() => {
        this.buffers.get(sessionId)?.clients.delete(context.connectionId);
      });
    }
    return {
      sessionId,
      lines: [...buffer.lines],
      state: buffer.state,
      dropped: buffer.dropped,
    };
  }

  detach(sessionId: string, context: CallContext): void {
    this.buffers.get(sessionId)?.clients.delete(context.connectionId);
  }

  /** Sessão apagada: o buffer vai junto. */
  forget(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /** Linhas atuais de uma sessão (testes e diagnóstico). */
  lines(sessionId: string): readonly AgentTerminalLine[] {
    return this.buffers.get(sessionId)?.lines ?? [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.buffers.clear();
  }

  private create(sessionId: string): SessionBuffer {
    const buffer: SessionBuffer = {
      lines: [],
      nextSeq: 1,
      dropped: 0,
      state: 'preparando',
      partial: undefined,
      tools: new Map(),
      asking: new Map(),
      clients: new Map(),
    };
    this.buffers.set(sessionId, buffer);
    return buffer;
  }

  private onEvent(event: FaklEvent): void {
    const id = event.subject;
    const buffer = this.buffers.get(id) ?? this.create(id);
    if (event.topic === 'agent.output') {
      const data = event.data as AgentOutputEventData;
      this.feed(buffer, id, data.kind, data.text, event.ts);
      return;
    }
    this.flushPartial(buffer, id, event.ts);
    const lines = this.format(buffer, event);
    if (lines.length > 0) this.emit(buffer, id, lines, event.ts);
  }

  /** Junta pedaços de saída em linhas: só o que fecha com quebra de linha sai agora. */
  private feed(
    buffer: SessionBuffer,
    id: string,
    kind: OutputKind,
    text: string,
    ts: string,
  ): void {
    if (buffer.partial && buffer.partial.kind !== kind) this.flushPartial(buffer, id, ts);
    const joined = (buffer.partial?.text ?? '') + sanitizeTerminalText(text);
    const parts = joined.split('\n');
    let tail = parts.pop() ?? '';
    const complete = [...parts];
    while (tail.length > LINE_MAX_CHARS) {
      complete.push(tail.slice(0, LINE_MAX_CHARS));
      tail = tail.slice(LINE_MAX_CHARS);
    }
    buffer.partial = tail ? { kind, text: tail } : undefined;
    if (complete.length > 0) {
      this.emit(
        buffer,
        id,
        complete.map((line) => this.paint(kind, line)),
        ts,
      );
    }
  }

  private flushPartial(buffer: SessionBuffer, id: string, ts?: string): void {
    const partial = buffer.partial;
    if (!partial) return;
    buffer.partial = undefined;
    this.emit(buffer, id, [this.paint(partial.kind, partial.text)], ts ?? new Date().toISOString());
  }

  private paint(kind: OutputKind, line: string): string {
    // A redação roda na linha inteira: um segredo cortado entre dois pedaços não escapa.
    const clean = this.redact(line);
    if (kind === 'thought') return `${GRAY}${clean}${RESET}`;
    if (kind === 'error') return `${RED}${clean}${RESET}`;
    return clean;
  }

  private redact(text: string): string {
    return this.options.redact?.(text) ?? text;
  }

  /** Uma linha de sistema (não é fala do agente): tira segredos e pinta. */
  private system(color: string, text: string): string {
    return `${color}${this.redact(text)}${RESET}`;
  }

  private format(buffer: SessionBuffer, event: FaklEvent): string[] {
    switch (event.topic) {
      case 'agent.prompt': {
        const { text } = event.data as { text: string };
        const all = sanitizeTerminalText(text).split('\n');
        const shown = all
          .slice(0, DETAIL_MAX_LINES)
          .map((line) => this.system(GREEN, `> ${line.slice(0, LINE_MAX_CHARS)}`));
        const more = all.length - DETAIL_MAX_LINES;
        if (more > 0) shown.push(this.system(GREEN, l10n.t('> (+{0} more lines)', String(more))));
        return shown;
      }
      case 'agent.tool': {
        const data = event.data as AgentToolEventData;
        const title = short(sanitizeTerminalText(data.title ?? data.kind ?? data.toolCallId));
        const status = data.status ? ` (${short(sanitizeTerminalText(data.status), 40)})` : '';
        const line = l10n.t('Tool: {0}{1}', title, status);
        if (buffer.tools.get(data.toolCallId) === line) return [];
        buffer.tools.delete(data.toolCallId);
        buffer.tools.set(data.toolCallId, line);
        if (buffer.tools.size > TOOLS_MAX) {
          const oldest = buffer.tools.keys().next().value;
          if (oldest !== undefined) buffer.tools.delete(oldest);
        }
        return [this.system(CYAN, line)];
      }
      case 'agent.permission': {
        const data = event.data as AgentPermissionEventData;
        const title = short(sanitizeTerminalText(data.title));
        buffer.asking.set(data.id, title);
        const lines = [this.system(YELLOW, l10n.t('Permission requested: {0}', title))];
        const detail = sanitizeTerminalText(data.detail ?? '')
          .split('\n')
          .filter((line) => line.trim() !== '');
        for (const line of detail.slice(0, DETAIL_MAX_LINES)) {
          lines.push(this.system(GRAY, `  ${short(line)}`));
        }
        if (detail.length > DETAIL_MAX_LINES) {
          const more = String(detail.length - DETAIL_MAX_LINES);
          lines.push(this.system(GRAY, l10n.t('  (+{0} more lines)', more)));
        }
        return lines;
      }
      case 'agent.answer': {
        const data = event.data as { id: string; allow: boolean };
        const title = buffer.asking.get(data.id) ?? short(sanitizeTerminalText(data.id));
        buffer.asking.delete(data.id);
        return data.allow
          ? [this.system(GREEN, l10n.t('Permission allowed: {0}', title))]
          : [this.system(RED, l10n.t('Permission denied: {0}', title))];
      }
      case 'agent.state': {
        const data = event.data as AgentStateEventData;
        buffer.state = data.state;
        if (isFinalAgentState(data.state)) buffer.asking.clear();
        const text = data.reason
          ? l10n.t(
              'State: {0} -> {1} ({2})',
              data.previous,
              data.state,
              short(sanitizeTerminalText(data.reason)),
            )
          : l10n.t('State: {0} -> {1}', data.previous, data.state);
        return [this.system(BLUE, text)];
      }
      case 'agent.file': {
        const { path } = event.data as { path: string };
        return [this.system(GRAY, l10n.t('Changed file: {0}', short(sanitizeTerminalText(path))))];
      }
      default:
        return [];
    }
  }

  private emit(buffer: SessionBuffer, id: string, texts: readonly string[], ts: string): void {
    const lines = texts.map((text) => ({ seq: buffer.nextSeq++, ts, text }));
    buffer.lines.push(...lines);
    const excess = buffer.lines.length - this.capacity;
    if (excess > 0) {
      buffer.lines.splice(0, excess);
      buffer.dropped += excess;
    }
    if (buffer.clients.size === 0) return;
    const params: AgentTerminalLinesParams = { sessionId: id, lines, state: buffer.state };
    for (const [connectionId, context] of [...buffer.clients]) {
      try {
        context.notify(CoreNotifications.terminalLines, params);
      } catch {
        // Um cliente com defeito não pode atrapalhar os outros.
        buffer.clients.delete(connectionId);
      }
    }
  }
}
