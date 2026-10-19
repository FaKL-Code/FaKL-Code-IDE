/**
 * Envelope e tópicos dos eventos do Core (SDD 6.4). A mesa de controle, o café
 * e o controle remoto só consomem eventos; nenhum deles consulta estado por
 * polling.
 */
export const EVENT_TOPICS = [
  'agent.state',
  'agent.output',
  'agent.tool',
  'agent.permission',
  'agent.file',
  'agent.thumbnail',
  'agent.mode',
  'agent.answer',
  'agent.applied',
  'agent.options',
  'agent.prompt',
  'agent.recovery',
  'agent.review',
  'run.agents',
  'run.round',
  'run.limit',
  'run.decision',
  'run.done',
  'cost.update',
  'config.changed',
  'vault.sync',
  'remote.device',
  'remote.status',
  'claude.account',
  'ci.run',
  'ui.reveal',
] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface FaklEvent<TData = unknown> {
  /** ULID, ordenável por tempo. */
  readonly id: string;
  /** Instante do evento em ISO 8601 (UTC). */
  readonly ts: string;
  readonly topic: EventTopic;
  /** Id do agente, tarefa ou execução a que o evento se refere. */
  readonly subject: string;
  readonly data: TData;
}

const topicSet: ReadonlySet<string> = new Set(EVENT_TOPICS);

export function isEventTopic(value: string): value is EventTopic {
  return topicSet.has(value);
}

/**
 * Testa se um tópico casa com um padrão de assinatura. O padrão pode ser um
 * tópico exato (`run.done`), um prefixo com curinga (`agent.*`) ou `*`.
 */
export function topicMatches(pattern: string, topic: EventTopic): boolean {
  if (pattern === '*' || pattern === topic) {
    return true;
  }
  if (pattern.endsWith('.*')) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}
