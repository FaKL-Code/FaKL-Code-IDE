import { l10n } from '@fakl/i18n';
import type { AgentProfile } from '@fakl/agents';

/** Nome do subagente explorador nas sessões do Claude Code. */
export const EXPLORADOR = 'explorador';

const ORDEM = { baixo: 0, médio: 1, alto: 2 } as const;

/**
 * Modelo do explorador de uma sessão do Claude: o do perfil do Claude mais
 * barato que o dela. Explorar o código é ler muito e concluir pouco, e cada
 * leitura feita pela conversa principal fica no contexto pago a cada passo;
 * num modelo mais barato e num contexto à parte, só a conclusão volta.
 * Sem perfil mais barato (a sessão já é a mais barata), não há explorador.
 */
export function exploradorDe(
  sessao: AgentProfile,
  perfis: readonly AgentProfile[],
): string | undefined {
  const custo = ORDEM[sessao.custoRelativo ?? 'médio'];
  const candidatos = perfis
    .filter(
      (perfil) =>
        perfil.provedor === 'anthropic' &&
        perfil.adaptador === 'acp' &&
        perfil.modelo !== undefined &&
        perfil.modelo !== sessao.modelo &&
        ORDEM[perfil.custoRelativo ?? 'médio'] < custo,
    )
    .sort((a, b) => ORDEM[a.custoRelativo ?? 'médio'] - ORDEM[b.custoRelativo ?? 'médio']);
  return candidatos[0]?.modelo;
}

export function exploradorPrompt(): string {
  return l10n.t(
    'You explore a codebase to answer one question for another agent, who pays for every line you send back. Read and search as much as you need, but do not edit anything. Answer with only what was asked: the relevant file paths with line numbers, short excerpts only when the exact text matters, and the conclusion. No preamble, no summary of what you did.',
  );
}
