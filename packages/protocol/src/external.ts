/**
 * Conversas das extensões oficiais do Codex e do Claude Code, só para olhar
 * (ADR 0039). O Core lê os metadados que as duas ferramentas guardam em disco;
 * não existe API para falar com essas conversas, então nada vai para elas.
 */
export const EXTERNAL_SOURCES = ['codex', 'claude-code'] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

export function isExternalSource(value: unknown): value is ExternalSource {
  return typeof value === 'string' && (EXTERNAL_SOURCES as readonly string[]).includes(value);
}

/** `ativa`: o arquivo da conversa mexeu há pouco ou a ferramenta diz que está ocupada. */
export type ExternalSessionState = 'ativa' | 'parada';

export interface ExternalSession {
  /** `<fonte>:<sessionId>`; não colide com os ids das sessões do Core. */
  readonly id: string;
  readonly fonte: ExternalSource;
  /** Id da conversa na ferramenta de origem. */
  readonly sessionId: string;
  /** `openai` (Codex) ou `anthropic` (Claude Code), para a marca e a cor. */
  readonly provedor: 'openai' | 'anthropic';
  /** Nome da conversa na ferramenta, quando ela guarda um; nunca o texto das mensagens. */
  readonly titulo?: string;
  /** Pasta onde a conversa foi aberta. */
  readonly pasta: string;
  readonly estado: ExternalSessionState;
  /** Último movimento do arquivo da conversa, ISO. */
  readonly atualizadaEm: string;
}

/** `external.status` e `external.setEnabled`. */
export interface ExternalStatus {
  readonly ativo: boolean;
}

export interface ExternalSetEnabledParams {
  readonly ativo: boolean;
}

/** `external.list`: vazio enquanto o usuário não deu o consentimento. */
export interface ExternalListResult extends ExternalStatus {
  readonly sessoes: readonly ExternalSession[];
}
