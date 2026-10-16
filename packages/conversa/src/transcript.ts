import {
  isFinalAgentState,
  type AgentAnswerEventData,
  type AgentAppliedEventData,
  type AgentOutputEventData,
  type AgentPermissionEventData,
  type AgentPromptEventData,
  type AgentStateEventData,
  type AgentToolEventData,
  type AgentTranscriptEntry,
  type ChatItem,
  type FaklEvent,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

export type { ChatItem };

/** Tópicos que mudam a conversa; quem monta uma `Transcript` assina estes. */
export const TRANSCRIPT_TOPICS = [
  'agent.prompt',
  'agent.output',
  'agent.tool',
  'agent.permission',
  'agent.answer',
  'agent.applied',
  'agent.state',
] as const;

function noticeFor(state: string): string | undefined {
  switch (state) {
    case 'pausado':
      return l10n.t('Agent paused.');
    case 'concluído':
      return l10n.t('Agent finished.');
    case 'falhou':
      return l10n.t('Agent failed.');
    case 'parado':
      return l10n.t('Agent stopped.');
    default:
      return undefined;
  }
}

/**
 * Conversa de uma sessão, montada a partir dos eventos `agent.*` do Core.
 * Cada mudança devolve os índices alterados, para o chat redesenhar só eles.
 */
export class Transcript {
  readonly items: ChatItem[] = [];

  /** Monta a conversa guardada pelo Core, para sessões que o chat não viu acontecer. */
  static replay(subject: string, entries: readonly AgentTranscriptEntry[]): Transcript {
    const transcript = new Transcript();
    for (const entry of entries) {
      if (entry.t === 'user') {
        transcript.addUser(entry.text);
      } else {
        transcript.apply({
          id: '',
          topic: entry.topic,
          subject,
          ts: entry.ts,
          data: entry.data,
        } as FaklEvent);
      }
    }
    return transcript;
  }

  /** Retoma uma conversa já montada, como a que `agents.transcript` devolve. */
  static from(items: readonly ChatItem[]): Transcript {
    const transcript = new Transcript();
    transcript.items.push(...items);
    return transcript;
  }

  addUser(text: string): number[] {
    return [this.items.push({ kind: 'user', text }) - 1];
  }

  /** Aviso da IDE na conversa, como onde o agente está trabalhando. */
  note(text: string): number[] {
    return this.push({ kind: 'notice', text, tone: 'info' });
  }

  apply(event: FaklEvent): number[] {
    switch (event.topic) {
      case 'agent.prompt':
        return this.addUser((event.data as AgentPromptEventData).text);
      case 'agent.output': {
        const data = event.data as AgentOutputEventData;
        if (data.kind === 'error')
          return this.push({ kind: 'notice', text: data.text, tone: 'error' });
        return this.appendText(data.kind === 'message' ? 'agent' : 'thought', data.text);
      }
      case 'agent.tool':
        return this.tool(event.data as AgentToolEventData);
      case 'agent.permission': {
        const data = event.data as AgentPermissionEventData;
        return this.push({
          kind: 'permission',
          id: data.id,
          title: data.title,
          ...(data.detail ? { detail: data.detail } : {}),
        });
      }
      case 'agent.answer': {
        // Respondido em outro lugar (celular, CLI) ou liberado pelo modo.
        const data = event.data as AgentAnswerEventData;
        return this.pendingPermissions().includes(data.id) ? this.answer(data.id, data.allow) : [];
      }
      case 'agent.applied': {
        const data = event.data as AgentAppliedEventData;
        const parts: string[] = [];
        if (data.aplicados.length > 0) {
          parts.push(l10n.t('Autopilot applied to your folder: {0}.', data.aplicados.join(', ')));
        }
        if (data.pendentes.length > 0) {
          parts.push(
            l10n.t(
              'Left for you, because they would conflict with what you changed: {0}.',
              data.pendentes.join(', '),
            ),
          );
        }
        return parts.length > 0 ? this.note(parts.join(' ')) : [];
      }
      case 'agent.state': {
        const data = event.data as AgentStateEventData;
        if (isFinalAgentState(data.previous) && !isFinalAgentState(data.state)) {
          // Uma sessão encerrada voltou a rodar (ADR 0022).
          const how = data.reason ? ` (${data.reason})` : '';
          return this.note(l10n.t('Session resumed{0}.', how));
        }
        const notice = noticeFor(data.state);
        if (!notice) return [];
        const text = data.reason ? `${notice} (${data.reason})` : notice;
        return this.push({
          kind: 'notice',
          text,
          tone: data.state === 'falhou' ? 'error' : 'info',
        });
      }
      default:
        return [];
    }
  }

  /** Marca o pedido de permissão como respondido. */
  answer(id: string, allow: boolean): number[] {
    const index = this.items.findLastIndex((item) => item.kind === 'permission' && item.id === id);
    const item = this.items[index];
    if (item?.kind !== 'permission') return [];
    this.items[index] = { ...item, answer: allow ? 'permitido' : 'negado' };
    return [index];
  }

  /** Descarta os itens mais antigos além de `max`; devolve quantos saíram. */
  trim(max: number): number {
    const extra = this.items.length - max;
    if (extra <= 0) return 0;
    this.items.splice(0, extra);
    return extra;
  }

  /** Última fala do agente, ou nada. */
  lastAnswer(): string | undefined {
    const item = this.items.findLast((i) => i.kind === 'agent');
    return item?.kind === 'agent' ? item.text : undefined;
  }

  /** Pedidos de permissão ainda sem resposta. */
  pendingPermissions(): string[] {
    return this.items.flatMap((item) =>
      item.kind === 'permission' && !item.answer ? [item.id] : [],
    );
  }

  private push(item: ChatItem): number[] {
    return [this.items.push(item) - 1];
  }

  private appendText(kind: 'agent' | 'thought', text: string): number[] {
    const index = this.items.length - 1;
    const last = this.items[index];
    if (last?.kind === kind) {
      this.items[index] = { kind, text: last.text + text };
      return [index];
    }
    return this.push({ kind, text });
  }

  private tool(data: AgentToolEventData): number[] {
    const index = this.items.findLastIndex(
      (item) => item.kind === 'tool' && item.id === data.toolCallId,
    );
    const previous = this.items[index];
    if (previous?.kind === 'tool') {
      this.items[index] = {
        ...previous,
        ...(data.title ? { title: data.title } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.kind ? { toolKind: data.kind } : {}),
      };
      return [index];
    }
    return this.push({
      kind: 'tool',
      id: data.toolCallId,
      title: data.title ?? 'Ferramenta',
      ...(data.status ? { status: data.status } : {}),
      ...(data.kind ? { toolKind: data.kind } : {}),
    });
  }
}
