import { l10n } from '@fakl/i18n';
import type {
  AgentChangedFile,
  AgentOptionInfo,
  AgentSessionInfo,
  AgentState,
} from '@fakl/protocol';

export {
  formatCost,
  PROVIDER_NAMES,
  formatTokens,
  preview,
  relativeTime,
  sumUsage,
  usageBreakdown,
  type UsageBreakdown,
} from '@fakl/conversa';

/**
 * Lógica pura do chat (sem DOM): filtro dos menus, tipos de arquivo, uso e
 * formatação. Fica separada de chat.ts para ser testada com Vitest.
 */

export type FileKind =
  'code' | 'data' | 'doc' | 'image' | 'style' | 'shell' | 'config' | 'lock' | 'folder' | 'file';

const EXTENSIONS: Record<string, FileKind> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  kt: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  cs: 'code',
  rb: 'code',
  php: 'code',
  swift: 'code',
  html: 'code',
  vue: 'code',
  sql: 'code',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  xml: 'data',
  csv: 'data',
  md: 'doc',
  mdx: 'doc',
  txt: 'doc',
  rst: 'doc',
  pdf: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  css: 'style',
  scss: 'style',
  less: 'style',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'shell',
  bat: 'shell',
  lock: 'lock',
  env: 'config',
  ini: 'config',
  conf: 'config',
};

const NAMES: Record<string, FileKind> = {
  dockerfile: 'config',
  makefile: 'config',
  '.gitignore': 'config',
  '.editorconfig': 'config',
  'pnpm-lock.yaml': 'lock',
  'package-lock.json': 'lock',
};

export function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1);
}

export function dirName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return cut < 0 ? '' : clean.slice(0, cut);
}

/** Tipo de arquivo pelo nome, para escolher o ícone. Caminho terminado em / é pasta. */
export function fileKind(path: string): FileKind {
  if (path.endsWith('/')) return 'folder';
  const name = baseName(path).toLowerCase();
  const byName = NAMES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'file';
  return EXTENSIONS[name.slice(dot + 1)] ?? 'file';
}

export type ToolIconName =
  'file' | 'pencil' | 'trash' | 'search' | 'terminal' | 'globe' | 'bulb' | 'wrench' | 'move';

/** Ícone da ferramenta pelo `kind` do ACP. */
export function toolIconName(kind: string | undefined): ToolIconName {
  switch (kind) {
    case 'read':
      return 'file';
    case 'edit':
      return 'pencil';
    case 'delete':
      return 'trash';
    case 'move':
      return 'move';
    case 'search':
      return 'search';
    case 'execute':
      return 'terminal';
    case 'fetch':
      return 'globe';
    case 'think':
      return 'bulb';
    default:
      return 'wrench';
  }
}

/** Item de um menu com filtro. */
export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly keywords?: string;
}

/**
 * Pontua `query` contra `text`: prefixo vale mais que trecho contíguo, que vale
 * mais que letras em ordem (fuzzy). `undefined` quando não bate. Menor é melhor.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 0;
  if (at > 0) {
    // Começo de palavra ou de segmento do caminho vale quase como prefixo.
    return /[\s/\\._-]/.test(t.charAt(at - 1)) ? 1 : 2 + at / 1000;
  }
  let from = 0;
  let gaps = 0;
  for (const char of q) {
    const found = t.indexOf(char, from);
    if (found < 0) return undefined;
    gaps += found - from;
    from = found + 1;
  }
  return 10 + gaps / 100;
}

/** Filtra e ordena (estável) pelo melhor resultado entre rótulo, palavras-chave e descrição. */
export function filterEntries<T extends MenuEntry>(entries: readonly T[], query: string): T[] {
  if (!query.trim()) return [...entries];
  const scored: { entry: T; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const scores = [
      fuzzyScore(query, entry.label),
      entry.keywords ? fuzzyScore(query, entry.keywords) : undefined,
      // A descrição só casa por trecho contíguo, e perde para o rótulo.
      entry.description?.toLowerCase().includes(query.trim().toLowerCase()) ? 8 : undefined,
    ].filter((score): score is number => score !== undefined);
    if (scores.length > 0) scored.push({ entry, score: Math.min(...scores), order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.entry);
}

/** Agrupa mantendo a ordem de primeira aparição de cada grupo. */
export function groupEntries<T extends MenuEntry>(
  entries: readonly T[],
): { group: string; entries: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = entry.group ?? '';
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups].map(([group, list]) => ({ group, entries: list }));
}

/** Move o item ativo com volta nas pontas. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/** Contexto anexado à mensagem pelos menus @ e #. */
export interface ContextChip {
  readonly kind: 'file' | 'agent' | 'context';
  readonly label: string;
  /** Texto que vai para a mensagem: `#caminho`, `@Nome` ou o texto do contexto. */
  readonly insert: string;
}

/** Monta o texto enviado: as menções dos chips vêm antes do que foi digitado. */
export function composeMessage(chips: readonly ContextChip[], text: string): string {
  const body = text.trim();
  if (chips.length === 0) return body;
  const unique = [...new Set(chips.map((chip) => chip.insert))];
  return body ? `${unique.join(' ')} ${body}` : unique.join(' ');
}

/** Cor do provedor, sempre por variável do tema (os gráficos do VS Code). */
export function providerColor(provedor: string | undefined): string {
  switch ((provedor ?? '').toLowerCase()) {
    case 'anthropic':
      return 'var(--vscode-charts-orange)';
    case 'openai':
      return 'var(--vscode-charts-green)';
    case 'google':
      return 'var(--vscode-charts-purple)';
    case 'ollama':
    case 'lmstudio':
    case 'local':
      return 'var(--vscode-charts-red)';
    default:
      return 'var(--vscode-charts-blue)';
  }
}

/** A ferramenta ainda não terminou (sem status, na fila ou rodando). */
export function toolRunning(status: string | undefined): boolean {
  return status === undefined || status === 'pending' || status === 'in_progress';
}

/** Estado da ferramenta para a tela; sem status (ou desconhecido) conta como na fila. */
export function toolStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'in_progress':
      return l10n.t('Running');
    case 'completed':
      return l10n.t('Complete');
    case 'failed':
      return l10n.t('Failed');
    default:
      return l10n.t('Queued');
  }
}

/** Estado da conversa para a tela (o valor do protocolo continua em pt-BR). */
export function agentStateLabel(state: AgentState): string {
  switch (state) {
    case 'preparando':
      return l10n.t('preparing');
    case 'ocioso':
      return l10n.t('idle');
    case 'pensando':
      return l10n.t('thinking');
    case 'executando':
      return l10n.t('running');
    case 'aguardando-permissão':
      return l10n.t('waiting for permission');
    case 'aguardando-você':
      return l10n.t('waiting for you');
    case 'pausado':
      return l10n.t('paused');
    case 'concluído':
      return l10n.t('finished');
    case 'falhou':
      return l10n.t('failed');
    case 'parado':
      return l10n.t('stopped');
  }
}

/** Tipo de mudança de um arquivo alterado pelo agente, para o tooltip da letra. */
export function changeStatusLabel(status: AgentChangedFile['status']): string {
  switch (status) {
    case 'adicionado':
      return l10n.t('added');
    case 'modificado':
      return l10n.t('modified');
    case 'removido':
      return l10n.t('removed');
  }
}

// --- Logos dos provedores ----------------------------------------------------------------------

export type LogoKey =
  'anthropic' | 'claude' | 'openai' | 'gemini' | 'google' | 'ollama' | 'lmstudio';

/**
 * Qual logo mostrar, pelo provedor do perfil (nunca pelo id dele). Um agente
 * usa a marca do produto: o Claude Code a do Claude, o Gemini CLI a do Gemini;
 * o provedor sozinho (anéis de uso) usa a da empresa. `undefined` quando não
 * há marca conhecida (cai nas iniciais), como num agente ACP cadastrado.
 */
export function logoKey(provedor: string | undefined, agente = false): LogoKey | undefined {
  switch ((provedor ?? '').toLowerCase()) {
    case 'anthropic':
      return agente ? 'claude' : 'anthropic';
    case 'google':
      return agente ? 'gemini' : 'google';
    case 'openai':
      return 'openai';
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'lmstudio';
    default:
      return undefined;
  }
}

// --- Opções do agente (ACP configOptions) -----------------------------------------------------

export type OptionKind = 'model' | 'effort' | 'mode' | 'fast' | 'other';

interface OptionLike {
  readonly id: string;
  readonly nome: string;
  readonly categoria?: string | undefined;
}

/** Reconhece o tipo da opção pela categoria do ACP e, na falta, pelo id ou nome. */
export function optionKind(option: OptionLike): OptionKind {
  const text = `${option.categoria ?? ''} ${option.id} ${option.nome}`.toLowerCase();
  if (option.categoria === 'model' || /\bmodel|modelo/.test(text)) return 'model';
  if (
    option.categoria === 'thought_level' ||
    /thought|effort|reason|racioc|esfor|think/.test(text)
  ) {
    return 'effort';
  }
  if (/\bfast\b|r[aá]pid/.test(text)) return 'fast';
  if (option.categoria === 'mode' || /\bmode\b|\bmodo\b|permiss|approval|aprova/.test(text)) {
    return 'mode';
  }
  return 'other';
}

const KIND_RANK: Record<OptionKind, number> = { model: 0, effort: 1, fast: 2, mode: 3, other: 4 };

/** Modelo primeiro, depois raciocínio, fast, modo e o resto; estável dentro de cada grupo. */
export function sortOptions<T extends OptionLike>(options: readonly T[]): T[] {
  return options
    .map((option, order) => ({ option, order, rank: KIND_RANK[optionKind(option)] }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.option);
}

/** Valor atual de uma opção como texto para a pílula. */
export function optionValueLabel(option: AgentOptionInfo): string {
  if (option.valores) {
    return option.valores.find((v) => v.id === String(option.atual))?.nome ?? option.nome;
  }
  return option.nome;
}

export type OptionChoices = Readonly<Record<string, string | boolean>>;

/** Guarda as opções vistas de cada perfil, para oferecê-las antes de a conversa existir. */
export function rememberOptions(
  known: Readonly<Record<string, readonly AgentOptionInfo[]>>,
  sessions: readonly Pick<AgentSessionInfo, 'profileId' | 'opcoes'>[],
): Record<string, readonly AgentOptionInfo[]> {
  const next = { ...known };
  for (const session of sessions) {
    if (session.opcoes.length > 0) next[session.profileId] = session.opcoes;
  }
  return next;
}

/** Valor mostrado para uma opção numa conversa nova: a escolha do usuário ou o último visto. */
export function withChoices(
  options: readonly AgentOptionInfo[],
  choices: OptionChoices,
): AgentOptionInfo[] {
  return options.map((option) => {
    const choice = choices[option.id];
    if (choice === undefined) return option;
    if (option.valores) {
      return typeof choice === 'string' && option.valores.some((v) => v.id === choice)
        ? { ...option, atual: choice }
        : option;
    }
    return typeof choice === 'boolean' ? { ...option, atual: choice } : option;
  });
}

/** O que falta mandar ao agente recém-aberto para ele ficar como o usuário escolheu. */
export function pendingOptionChanges(
  options: readonly AgentOptionInfo[],
  choices: OptionChoices,
): { id: string; value: string | boolean }[] {
  const changes: { id: string; value: string | boolean }[] = [];
  for (const option of options) {
    const choice = choices[option.id];
    if (choice === undefined || choice === option.atual) continue;
    const valid = option.valores
      ? typeof choice === 'string' && option.valores.some((v) => v.id === choice)
      : typeof choice === 'boolean';
    if (valid) changes.push({ id: option.id, value: choice });
  }
  return changes;
}

/** A conversa que acabou de abrir para o perfil, entre as que já existiam antes. */
export function findNewSession<T extends Pick<AgentSessionInfo, 'sessionId' | 'profileId'>>(
  before: ReadonlySet<string>,
  sessions: readonly T[],
  profileId: string,
): T | undefined {
  return sessions.find((s) => s.profileId === profileId && !before.has(s.sessionId));
}

/**
 * Pedido de permissão numa linha só, com os argumentos da chamada (um por linha
 * no `detail`) separados por ` · `, para notificações e textos copiados.
 */
export function permissionLine(title: string, detail?: string, max = 300): string {
  const args = (detail ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' · ');
  if (!args) return title;
  const line = `${title} (${args})`;
  return line.length > max ? `${line.slice(0, max - 2)}…)` : line;
}
