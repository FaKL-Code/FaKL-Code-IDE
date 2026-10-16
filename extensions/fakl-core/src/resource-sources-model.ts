import { l10n } from '@fakl/i18n';
import type { ResourceSource } from '@fakl/protocol';

/** Mesmo filtro do Core: transportes de rede, `file://` ou `usuario@host:caminho`. */
const URL_SCHEME = /^(?:https?|ssh|git|file):\/\//i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\\]/;

/** Mensagem de erro para a caixa de URL; `undefined` quando a URL serve. */
export function gitUrlProblem(value: string): string | undefined {
  const url = value.trim();
  if (!url) return l10n.t('Enter the repository URL.');
  if (url.startsWith('-') || /\s/.test(url)) return l10n.t('Invalid URL.');
  if (!URL_SCHEME.test(url) && !SCP_LIKE.test(url)) {
    return l10n.t('Use https://, ssh://, git://, file:// or user@host:path.');
  }
  return undefined;
}

/** "3 agentes, 1 skill, 2 MCPs"; vazio quando a fonte não oferece nada. */
export function sourceCounts(source: Pick<ResourceSource, 'agents' | 'skills' | 'mcps'>): string {
  const parts = [
    source.agents === 1 ? l10n.t('1 agent') : '',
    source.agents > 1 ? l10n.t('{0} agents', source.agents) : '',
    source.skills === 1 ? l10n.t('1 skill') : '',
    source.skills > 1 ? l10n.t('{0} skills', source.skills) : '',
    source.mcps === 1 ? l10n.t('1 MCP') : '',
    source.mcps > 1 ? l10n.t('{0} MCPs', source.mcps) : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : l10n.t('no resources');
}

/** Linha curta ao lado do nome: tipo, branch e o que oferece (ou o erro). */
export function sourceDescription(source: ResourceSource): string {
  if (source.erro) return source.erro;
  const kind =
    source.tipo === 'git' ? `git${source.branch ? ` · ${source.branch}` : ''}` : l10n.t('folder');
  return `${kind} · ${sourceCounts(source)}`;
}

/** Item oferecido por uma fonte, como aparece na lista de instalação. */
export interface OfferedItem {
  readonly name: string;
  readonly fonte: string;
  /** `false` só quando a fonte marca o item como opcional (`fakl.padrao: false`). */
  readonly padrao?: boolean;
  readonly instalado: boolean;
}

export interface OfferedGroup<T extends OfferedItem> {
  readonly fonte: string;
  /** Nome da fonte para o separador; o id quando a fonte não está mais na lista. */
  readonly nome: string;
  readonly items: readonly T[];
}

/**
 * Itens ainda não instalados, agrupados por fonte na ordem das fontes, com os
 * recomendados primeiro e depois em ordem alfabética.
 */
export function groupOffered<T extends OfferedItem>(
  items: readonly T[],
  sources: readonly Pick<ResourceSource, 'id' | 'nome'>[],
): OfferedGroup<T>[] {
  const order = new Map(sources.map((source, index) => [source.id, index]));
  const names = new Map(sources.map((source) => [source.id, source.nome]));
  const byFonte = new Map<string, T[]>();
  for (const item of items) {
    if (item.instalado) continue;
    const list = byFonte.get(item.fonte) ?? [];
    list.push(item);
    byFonte.set(item.fonte, list);
  }
  return [...byFonte.entries()]
    .sort(
      ([a], [b]) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.localeCompare(b),
    )
    .map(([fonte, list]) => ({
      fonte,
      nome: names.get(fonte) ?? fonte,
      items: [...list].sort(
        (a, b) =>
          Number(a.padrao === false) - Number(b.padrao === false) || a.name.localeCompare(b.name),
      ),
    }));
}

/** Escolhidos agrupados por fonte, para um pedido de instalação por fonte. */
export function namesBySource(
  picked: readonly Pick<OfferedItem, 'name' | 'fonte'>[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const { name, fonte } of picked) {
    const names = result.get(fonte) ?? [];
    if (!names.includes(name)) names.push(name);
    result.set(fonte, names);
  }
  return result;
}
