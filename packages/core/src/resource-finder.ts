import { l10n } from '@fakl/i18n';
import {
  isResourceKind,
  type ResourceHit,
  type ResourceKind,
  type ResourceLevel,
} from '@fakl/protocol';

import type { McpLibrary } from './mcp-library.js';
import type { ResourceLibrary } from './resources.js';
import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';

type HitKind = ResourceHit['kind'];

/** Item pesquisável: agente, skill ou servidor MCP, instalado ou só numa fonte. */
export interface SearchItem {
  readonly kind: HitKind;
  readonly name: string;
  readonly description: string;
  readonly nivel?: ResourceLevel;
  readonly perfil?: string;
  readonly categoria?: string;
  readonly instalado: boolean;
  readonly faltando?: readonly string[];
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DESCRIPTION_MAX = 200;

// Palavras que aparecem em quase toda descrição ("Use quando…", "para criar…") e não distinguem nada.
const STOPWORDS = new Set(
  (
    'use usar usa quando como para pela pelo pelas pelos com sem que uma umas uns dos das nos nas ' +
    'por mais menos antes depois sobre entre cada todo toda todos todas isso esse essa este esta ' +
    'ser sao foi tem ter seu sua seus suas qualquer algo ainda tambem ate the and for with from ' +
    'into when what that this your you are not can will use using any all task tarefa fazer faz ' +
    'precisa preciso quero codigo code'
  ).split(' '),
);

/** Tokens comparáveis: sem acento, minúsculos, sem palavras vazias. */
export function searchTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
    ),
  ];
}

/** Mesma palavra com outra flexão: "teste", "testes", "testing"; "deploy", "deployment". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return true;
  let common = 0;
  while (common < short.length && short[common] === long[common]) common++;
  return common >= 5;
}

/**
 * Os nomes dos recursos costumam ser em inglês e as tarefas chegam em português: cada
 * palavra comum de pedido também procura o equivalente em inglês.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  corrigir: ['fix', 'bug', 'debug', 'debugging'],
  correcao: ['fix', 'bug'],
  erro: ['error', 'bug', 'debug'],
  falha: ['bug', 'failing', 'debug'],
  falhando: ['failing', 'bug', 'debug'],
  quebrado: ['bug', 'debug', 'broken'],
  depurar: ['debug', 'debugger', 'debugging'],
  diagnosticar: ['debug', 'diagnosing'],
  teste: ['test', 'testing'],
  testar: ['test', 'testing'],
  seguranca: ['security', 'secure'],
  vulnerabilidade: ['security', 'vulnerability'],
  documentacao: ['docs', 'documentation', 'readme'],
  documentar: ['docs', 'documentation'],
  banco: ['database', 'sql', 'postgres'],
  dados: ['data', 'database'],
  consulta: ['query', 'sql'],
  navegador: ['browser', 'playwright', 'webapp'],
  implantar: ['deploy', 'deployment'],
  implantacao: ['deploy', 'deployment'],
  desempenho: ['performance'],
  lentidao: ['performance', 'slow'],
  revisao: ['review', 'reviewer'],
  revisar: ['review', 'reviewer'],
  refatorar: ['refactor', 'refactoring'],
  refatoracao: ['refactor', 'refactoring'],
  acessibilidade: ['accessibility', 'a11y'],
  interface: ['frontend', 'design'],
  tela: ['frontend', 'design'],
  pagina: ['frontend', 'page', 'design'],
  landing: ['frontend', 'design', 'page'],
  visual: ['design', 'frontend'],
  componente: ['component', 'frontend'],
  arquitetura: ['architecture', 'architect'],
  plano: ['plan', 'plans', 'writing'],
  planejar: ['plan', 'plans', 'brainstorming'],
  dependencia: ['dependency', 'dependencies'],
  dependencias: ['dependency', 'dependencies'],
  conteiner: ['docker', 'container'],
  container: ['docker'],
  migracao: ['migration', 'migrations', 'legacy'],
  migrar: ['migration', 'migrations', 'legacy'],
  tipos: ['typescript', 'types'],
  prompt: ['prompt', 'prompts'],
  agente: ['agent', 'agents'],
  servidor: ['server'],
  celular: ['mobile'],
  aplicativo: ['app', 'mobile'],
  incidente: ['incident'],
  registro: ['logs', 'logging'],
  logs: ['observability', 'logging'],
  metricas: ['metrics', 'observability'],
};

/** Grupos de busca: a palavra da tarefa e os sinônimos dela. */
function queryGroups(tarefa: string): string[][] {
  return searchTokens(tarefa).map((token) => [token, ...(SYNONYMS[token] ?? [])]);
}

function matches(group: readonly string[], field: readonly string[]): boolean {
  return group.some((token) => field.some((candidate) => sameWord(token, candidate)));
}

function shortDescription(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : line;
}

interface Fields {
  readonly name: string[];
  readonly categoria: string[];
  readonly description: string[];
}

/**
 * Ordena os itens pela relevância para a tarefa. Cada palavra (com sinônimos)
 * vale 3 no nome, 1,5 na categoria e 1 na descrição, vezes a raridade dela no
 * acervo (IDF): "jira" decide mais que "teste". Instalado desempata.
 */
export function rankResources(
  tarefa: string,
  items: readonly SearchItem[],
  limit = DEFAULT_LIMIT,
): ResourceHit[] {
  const groups = queryGroups(tarefa);
  if (groups.length === 0 || items.length === 0) return [];
  const fields: Fields[] = items.map((item) => ({
    name: searchTokens(item.name),
    categoria: searchTokens(item.categoria ?? ''),
    description: searchTokens(item.description),
  }));
  const idf = groups.map((group) => {
    const df = fields.filter(
      (f) => matches(group, f.name) || matches(group, f.categoria) || matches(group, f.description),
    ).length;
    return Math.log(1 + items.length / Math.max(1, df));
  });
  const scored: ResourceHit[] = [];
  items.forEach((item, index) => {
    const field = fields[index];
    if (!field) return;
    let score = 0;
    groups.forEach((group, g) => {
      const weight = matches(group, field.name)
        ? 3
        : matches(group, field.categoria)
          ? 1.5
          : matches(group, field.description)
            ? 1
            : 0;
      score += weight * (idf[g] ?? 1);
    });
    if (score === 0) return;
    if (item.instalado) score *= 1.1;
    scored.push({
      kind: item.kind,
      name: item.name,
      description: shortDescription(item.description),
      ...(item.nivel ? { nivel: item.nivel } : {}),
      ...(item.perfil ? { perfil: item.perfil } : {}),
      ...(item.categoria ? { categoria: item.categoria } : {}),
      instalado: item.instalado,
      ...(item.faltando?.length ? { faltando: item.faltando } : {}),
      score: Math.round(score * 100) / 100,
    });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))));
}

export interface ResourceFinderOptions {
  readonly resources?: ResourceLibrary;
  readonly mcps?: McpLibrary;
}

/** Agentes, skills e servidores MCP: instalados, do usuário e das fontes de recursos. */
export async function searchItems(
  options: ResourceFinderOptions,
  kinds: ReadonlySet<HitKind>,
): Promise<SearchItem[]> {
  const items: SearchItem[] = [];
  const { resources, mcps } = options;
  if (resources && (kinds.has('agent') || kinds.has('skill'))) {
    const [catalog, installed] = await Promise.all([resources.catalog(), resources.list()]);
    for (const kind of ['agent', 'skill'] as const) {
      if (!kinds.has(kind)) continue;
      // A versão instalada (que o usuário pode ter editado) vence: é ela que o spawn_agent injeta.
      const own = (kind === 'agent' ? installed.agents : installed.skills).map((info) => ({
        ...info,
        instalado: true,
      }));
      const seen = new Set(own.map((info) => info.name));
      const fromCatalog = (kind === 'agent' ? catalog.agents : catalog.skills).filter(
        (info) => !seen.has(info.name),
      );
      for (const info of [...own, ...fromCatalog]) {
        items.push({
          kind,
          name: info.name,
          description: info.description,
          ...(info.nivel ? { nivel: info.nivel } : {}),
          ...(info.perfil ? { perfil: info.perfil } : {}),
          instalado: info.instalado,
        });
      }
    }
  }
  if (mcps && kinds.has('mcp')) {
    const [catalog, installed] = await Promise.all([mcps.catalog(), mcps.list()]);
    const byName = new Map(installed.servers.map((server) => [server.name, server]));
    const seen = new Set<string>();
    for (const server of [...installed.servers, ...catalog.servers]) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      const own = byName.get(server.name);
      // O bloco fakl vem de um arquivo editável à mão: só texto entra na busca.
      const descricao: unknown = server.fakl?.descricao;
      const categoria: unknown = server.fakl?.categoria;
      items.push({
        kind: 'mcp',
        name: server.name,
        description: typeof descricao === 'string' ? descricao : '',
        ...(typeof categoria === 'string' && categoria ? { categoria } : {}),
        instalado: !!own,
        ...(own?.faltando.length ? { faltando: own.faltando } : {}),
      });
    }
  }
  return items;
}

function kindsParam(value: unknown): Set<HitKind> {
  if (value === undefined) return new Set<HitKind>(['agent', 'skill', 'mcp']);
  if (!Array.isArray(value) || value.length === 0) {
    throw RpcError.invalidParams(l10n.t('tipos must be a list with agent, skill or mcp'));
  }
  const kinds = new Set<HitKind>();
  for (const item of value) {
    if (item !== 'mcp' && !isResourceKind(item)) {
      throw RpcError.invalidParams(
        l10n.t('invalid type: {0}; use agent, skill or mcp', String(item)),
      );
    }
    kinds.add(item as ResourceKind | 'mcp');
  }
  return kinds;
}

/** `resources.find`: os recursos mais úteis para uma tarefa, para o maestro escolher. */
export function registerResourceFinder(router: Router, options: ResourceFinderOptions): void {
  router.register('resources.find', async (params) => {
    const p = objectParams(params);
    const tarefa = stringParam(p, 'tarefa');
    const limite = typeof p.limite === 'number' && p.limite > 0 ? p.limite : DEFAULT_LIMIT;
    return rankResources(tarefa, await searchItems(options, kindsParam(p.tipos)), limite);
  });
}
