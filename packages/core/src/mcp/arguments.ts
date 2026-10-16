import { l10n } from '@fakl/i18n';

import type { McpTool } from './tools.js';

/**
 * Nomes em inglês que os modelos chutam para os parâmetros das ferramentas,
 * com os nomes em português que elas usam, em ordem de preferência. O Claude
 * Code deixa as ferramentas MCP deferidas (sem schema) até um ToolSearch, e a
 * primeira chamada costuma sair como `{ host, command }` em vez de
 * `{ host, comando }`.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  command: ['comando'],
  cmd: ['comando'],
  path: ['caminho'],
  file: ['caminho'],
  filePath: ['caminho'],
  file_path: ['caminho'],
  content: ['conteudo'],
  contents: ['conteudo'],
  encoding: ['codificacao'],
  createDirs: ['criarPastas'],
  mkdir: ['criarPastas'],
  parents: ['criarPastas'],
  timeout: ['timeoutSeg'],
  timeoutSec: ['timeoutSeg'],
  timeoutSeconds: ['timeoutSeg'],
  timeout_seconds: ['timeoutSeg'],
  workdir: ['cwd'],
  workingDirectory: ['cwd'],
  directory: ['cwd', 'caminho'],
  dir: ['cwd', 'caminho'],
  domain: ['dominio'],
  records: ['registros'],
  name: ['nome'],
  title: ['titulo'],
  body: ['corpo'],
  text: ['texto'],
  message: ['texto'],
  question: ['pergunta'],
  options: ['opcoes'],
  instructions: ['instrucoes'],
  criteria: ['criterio'],
  role: ['papel'],
  task: ['tarefa'],
  query: ['consulta', 'busca'],
  search: ['busca', 'consulta'],
  limit: ['limite'],
  action: ['acao'],
  reason: ['motivo'],
  summary: ['resumo'],
  verdict: ['veredito'],
  state: ['estado'],
  number: ['numero'],
  protocol: ['protocolo'],
  port: ['porta'],
  source: ['origem'],
  ruleId: ['regraId'],
  mode: ['modo'],
  note: ['nota'],
  draft: ['rascunho'],
  lines: ['linhas'],
  archived: ['arquivados'],
  checks: ['verificacoes'],
  all: ['todas'],
  types: ['tipos'],
  relation: ['relacao'],
};

interface PropertySchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
}

function properties(tool: McpTool): Record<string, PropertySchema> {
  const props = tool.inputSchema.properties;
  return props && typeof props === 'object' ? (props as Record<string, PropertySchema>) : {};
}

function required(tool: McpTool): string[] {
  const list = tool.inputSchema.required;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [];
}

/** Nome do tipo JSON para o modelo, no idioma da interface. */
function typeName(type: string | undefined): string | undefined {
  switch (type) {
    case 'string':
      return l10n.t('text');
    case 'number':
    case 'integer':
      return l10n.t('number');
    case 'boolean':
      return l10n.t('yes/no');
    case 'array':
      return l10n.t('list');
    case 'object':
      return l10n.t('object');
    default:
      return undefined;
  }
}

/** Os parâmetros da ferramenta em uma linha, para o modelo acertar a próxima chamada. */
export function describeParameters(tool: McpTool): string {
  const needed = new Set(required(tool));
  const parts = Object.entries(properties(tool)).map(([name, schema]) => {
    const notes = [
      schema.enum ? schema.enum.map(String).join(' | ') : typeName(schema.type),
      needed.has(name) ? l10n.t('required') : undefined,
    ].filter(Boolean);
    return notes.length > 0 ? `${name} (${notes.join(', ')})` : name;
  });
  return parts.length > 0
    ? l10n.t('Parameters of {0}: {1}.', tool.name, parts.join('; '))
    : l10n.t('{0} takes no parameters.', tool.name);
}

export type PreparedArguments =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Confere os argumentos de uma chamada antes de ela ir ao Core: troca os nomes
 * em inglês conhecidos pelos do schema e recusa, com a lista de parâmetros, a
 * chamada sem os obrigatórios. Nomes desconhecidos seguem como vieram.
 */
export function prepareArguments(tool: McpTool, raw: unknown): PreparedArguments {
  raw ??= {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      message: `${l10n.t('the arguments must be an object.')} ${describeParameters(tool)}`,
    };
  }
  const known = properties(tool);
  const given = raw as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    const target =
      name in known
        ? undefined
        : ALIASES[name]?.find(
            (candidate) => candidate in known && !(candidate in given) && !(candidate in args),
          );
    args[target ?? name] = value;
  }
  const missing = required(tool).filter(
    (name) => args[name] === undefined || args[name] === null || args[name] === '',
  );
  if (missing.length === 0) return { ok: true, args };
  const unknown = Object.keys(args).filter((name) => !(name in known));
  return {
    ok: false,
    message: [
      l10n.t('missing required arguments: {0}.', missing.join(', ')),
      unknown.length > 0 ? l10n.t('Unknown arguments: {0}.', unknown.join(', ')) : '',
      describeParameters(tool),
    ]
      .filter(Boolean)
      .join(' '),
  };
}
