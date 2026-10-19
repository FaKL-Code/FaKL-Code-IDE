import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { l10n } from '@fakl/i18n';
import type { Run, Task } from '@fakl/protocol';

import type { VaultConfig } from '../config.js';
import type { CostTracker } from '../costs.js';
import type { Disposable, EventBus } from '../events/bus.js';
import { git, run } from '../exec.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from '../rpc/router.js';
import { mergeCriterio } from './criterio.js';
import { fold, VaultIndex, type IndexedNote } from './index.js';
import { linkTarget } from './parse.js';
import { SemanticIndex, type EmbedFetch, type SemanticStatus } from './semantic.js';
import { VaultSync, type SyncResult } from './sync.js';

/** Estrutura sugerida (SDD 10.1), criada só num vault novo. */
export const VAULT_FOLDERS = [
  'Inbox',
  'Diário',
  'Projetos',
  'Agentes/Sessões',
  'Agentes/Memória',
  'Playbooks',
  'Templates',
  'Anexos',
];

/** Pastas onde agentes escrevem sem confirmação (SDD 10.4). */
const AGENT_WRITABLE = ['Agentes/', 'Projetos/'];
const NOTE_LIMIT = 60_000;
const PUSH_INTERVAL_MS = 2 * 60_000;
const PULL_INTERVAL_MS = 5 * 60_000;

export interface VaultStatus {
  readonly ativo: boolean;
  readonly caminho?: string;
  readonly notas: number;
  readonly sincroniza: boolean;
  readonly ultimaSincronizacao?: string;
  readonly ultimoErro?: string;
  readonly conflitos: readonly string[];
  readonly semantica?: SemanticStatus;
}

export interface PlaybookInfo {
  readonly nome: string;
  readonly caminho: string;
  readonly maestro?: string;
  readonly entrega?: string;
  readonly papeisFixados?: Readonly<Record<string, string>>;
  readonly limites?: unknown;
  /** Critério de pronto do playbook (SDD 9.4), repassado à tarefa. */
  readonly criterio?: unknown;
  readonly instrucoes: string;
}

export interface VaultServiceOptions {
  readonly bus: EventBus;
  readonly config: () => VaultConfig | undefined;
  readonly costs?: CostTracker;
  readonly orchestrator?: Orchestrator;
  readonly log?: (message: string) => void;
  readonly clock?: () => Date;
  readonly machine?: string;
  /** Tira segredos do texto que agentes gravam e das notas de sessão (SDD 14.1). */
  readonly redact?: (text: string) => string;
  /** Pasta de dados do Core, onde ficam os vetores da busca semântica. */
  readonly dataDir?: string;
  /** `fetch` do servidor de embeddings; padrão, o global. */
  readonly fetch?: EmbedFetch;
  /** Chave da API de embeddings, do cofre de segredos (ADR 0050). */
  readonly embeddingsKey?: () => string | undefined;
  /** Espera entre tentativas do limite de taxa; só os testes trocam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Avisa o que o cache de embeddings poupou de enviar (livro-caixa da economia, ADR 0052). */
  readonly economizou?: (poupado: { itens: number; caracteres: number }) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localDate(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Nome de arquivo seguro em qualquer sistema. */
export function safeFileName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Chave para casar nomes de projeto: sem acento, caixa, hífen nem espaço. */
function projectKey(name: string): string {
  return fold(name).replace(/[^a-z0-9]/g, '');
}

/**
 * Pasta do projeto em `Projetos/` para um repositório: a que já existe com o
 * mesmo nome (`fakl-code-ide` casa com `FaKL-Code-IDE`) ou o nome da pasta do repo.
 */
export function projectFolder(repoPath: string, existing: readonly string[]): string {
  const name = safeFileName(repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Sem projeto');
  const key = projectKey(name);
  return existing.find((folder) => projectKey(folder) === key) ?? name;
}

/** Tag do projeto (`projeto/fakl-code-ide`). */
export function projectTag(project: string): string {
  return `projeto/${fold(project)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

/**
 * Põe `line` no fim da seção `## heading`, criando a seção se faltar. Se uma
 * linha já contém `key`, ela é trocada no lugar, sem duplicar.
 */
export function upsertInSection(text: string, heading: string, line: string, key = line): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  const existing = lines.findIndex((l) => l.includes(key));
  if (existing >= 0) {
    lines[existing] = line;
    return `${lines.join('\n')}\n`;
  }
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return `${lines.join('\n')}\n\n## ${heading}\n\n${line}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  // Antes das linhas em branco do fim da seção; tira o "Nenhuma." do modelo.
  let at = end;
  while (at > start + 1 && lines[at - 1]?.trim() === '') at--;
  // O modelo traz "Nenhuma." em pt-BR ou "None." em inglês, conforme o idioma de quem criou a nota.
  if (at > start + 1 && /^_?(Nenhuma|None)\.?_?$/.test(lines[at - 1]?.trim() ?? '')) {
    lines.splice(at - 1, 1, line);
  } else {
    lines.splice(at, 0, ...(at === start + 1 ? ['', line] : [line]));
  }
  return `${lines.join('\n')}\n`;
}

/** Troca ou acrescenta o bloco `## …` marcado com `marker` (entrada do devlog). */
export function upsertBlock(text: string, marker: string, block: string): string {
  const at = text.indexOf(marker);
  const body = block.replace(/\n+$/, '');
  if (at < 0) return `${text.replace(/\n+$/, '')}\n\n${body}\n`;
  const start = text.lastIndexOf('\n## ', at) + 1;
  const next = text.indexOf('\n## ', at);
  const end = next < 0 ? text.length : next + 1;
  const rest = text.slice(end);
  return `${text.slice(0, start)}${body}\n${rest ? `\n${rest}` : ''}`;
}

/**
 * O vault (SDD 10): índice, sincronização, ferramentas dos agentes, notas de
 * execução (RF-406) e playbooks (RF-208). Agentes chegam aqui com o token da
 * sessão (`context.principal`): não veem notas privadas e só escrevem em
 * `Agentes/` e `Projetos/`.
 */
export class VaultService implements Disposable {
  private index: VaultIndex | undefined;
  private sync: VaultSync | undefined;
  private semantic: SemanticIndex | undefined;
  private timers: NodeJS.Timeout[] = [];
  private lastSync: string | undefined;
  private lastError: string | undefined;
  private conflicts: string[] = [];
  private memory: Promise<void> = Promise.resolve();
  private readonly subscription: Disposable;
  private readonly clock: () => Date;

  constructor(private readonly options: VaultServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.subscription = options.bus.subscribe(['run.done'], (event) => {
      // Em fila: execuções que terminam juntas mexem no mesmo índice e devlog.
      this.memory = this.memory
        .then(() => this.writeRunNote(event.data as Run))
        .catch((error: unknown) => {
          options.log?.(l10n.t('could not write the run note: {0}', String(error)));
        });
    });
  }

  get active(): boolean {
    return this.index !== undefined;
  }

  get root(): string | undefined {
    return this.index?.root;
  }

  /** Abre o vault da configuração; sem configuração, fica desligado. */
  async open(): Promise<void> {
    this.close();
    const config = this.options.config();
    if (!config) return;
    const root = config.caminho;
    if (!existsSync(root) && config.remoto) {
      await mkdir(dirname(root), { recursive: true });
      const cloned = await run('git', ['clone', '-q', config.remoto, root], {
        cwd: dirname(root),
        timeoutMs: 300_000,
      });
      if (cloned.code !== 0) this.lastError = l10n.t('Clone failed: {0}', cloned.stderr.trim());
    }
    const fresh = !existsSync(root) || (await readdir(root).catch(() => [])).length === 0;
    await mkdir(root, { recursive: true });
    if (fresh) {
      for (const folder of VAULT_FOLDERS) await mkdir(join(root, folder), { recursive: true });
    }
    this.index = new VaultIndex(root);
    this.sync = new VaultSync({
      root,
      ...(this.options.machine ? { machine: this.options.machine } : {}),
      clock: this.clock,
    });
    const syncs = config.sincronizar ?? true;
    if (syncs && (await this.sync.enabled())) {
      // Ao abrir: traz o que veio da outra máquina antes de indexar.
      await this.runSync();
      this.timers.push(
        setInterval(() => {
          void this.sync?.hasLocalChanges().then((dirty) => (dirty ? this.runSync() : undefined));
        }, PUSH_INTERVAL_MS),
        setInterval(() => void this.runSync(), PULL_INTERVAL_MS),
      );
      for (const timer of this.timers) timer.unref();
    }
    await this.index.build();
    this.index.watch();
    if (config.semantica) {
      const semantic = new SemanticIndex({
        config: config.semantica,
        ...(this.options.dataDir ? { file: join(this.options.dataDir, 'embeddings.json') } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
        ...(this.options.embeddingsKey ? { apiKey: this.options.embeddingsKey } : {}),
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
        ...(this.options.economizou ? { economizou: this.options.economizou } : {}),
      });
      this.semantic = semantic;
      await semantic.start(this.index);
    }
    this.options.log?.(l10n.t('vault opened at {0} ({1} notes)', root, String(this.index.size)));
  }

  /** A chave de embeddings mudou: tenta de novo o que parou por falta ou recusa dela. */
  embeddingsKeyChanged(): void {
    this.semantic?.reconcile();
  }

  /** Sincroniza agora e publica `vault.sync`. */
  async runSync(): Promise<SyncResult> {
    if (!this.sync) return { ok: false, changed: false, conflicts: [], error: l10n.t('No vault') };
    this.options.bus.publish('vault.sync', 'vault', { fase: 'inicio' });
    const result = await this.sync.sync();
    this.lastSync = this.clock().toISOString();
    this.lastError = result.error;
    if (result.conflicts.length > 0) this.conflicts = [...this.conflicts, ...result.conflicts];
    if (result.changed) {
      await this.index?.build();
      this.semantic?.reconcile();
    }
    this.options.bus.publish('vault.sync', 'vault', { fase: 'fim', ...result });
    return result;
  }

  /** Ao fechar a IDE: última sincronização, com prazo curto. */
  async flush(): Promise<void> {
    if (!this.sync || !(await this.sync.hasLocalChanges().catch(() => false))) return;
    await Promise.race([this.runSync(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }

  close(): void {
    this.semantic?.dispose();
    this.semantic = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.index?.dispose();
    this.index = undefined;
    this.sync = undefined;
  }

  dispose(): void {
    this.subscription.dispose();
    this.close();
  }

  status(): VaultStatus {
    return {
      ativo: this.active,
      ...(this.root ? { caminho: this.root } : {}),
      notas: this.index?.size ?? 0,
      sincroniza: this.timers.length > 0,
      ...(this.lastSync ? { ultimaSincronizacao: this.lastSync } : {}),
      ...(this.lastError ? { ultimoErro: this.lastError } : {}),
      conflitos: this.conflicts,
      ...(this.semantic ? { semantica: this.semantic.status() } : {}),
    };
  }

  private require(): VaultIndex {
    if (!this.index) {
      throw RpcError.invalidParams(l10n.t('No vault configured; set vault.caminho in config.yaml'));
    }
    return this.index;
  }

  /** Nota pelo caminho ou pelo nome, respeitando a privacidade para agentes. */
  private note(ref: string, agent: boolean): IndexedNote {
    const index = this.require();
    const note = index.get(ref) ?? index.resolve(linkTarget(ref));
    if (!note || (agent && note.private))
      throw RpcError.notFound(l10n.t('Note {0} not found', ref));
    return note;
  }

  private safePath(path: string): string {
    const index = this.require();
    const withExt = path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
    const rel = isAbsolute(withExt) ? undefined : index.relative(withExt);
    if (!rel) throw RpcError.invalidParams(l10n.t('Path outside the vault: {0}', path));
    return rel;
  }

  search(query: string, limit: number, agent: boolean): unknown {
    return this.require().search(query, { limit, includePrivate: !agent });
  }

  /** Busca por sentido (RF-407); notas privadas nunca entram no índice semântico. */
  async semanticSearch(query: string, limit: number): Promise<unknown> {
    this.require();
    if (!this.semantic) {
      throw RpcError.invalidParams(
        l10n.t('Semantic search is off; turn on vault.semantica in config.yaml or use text search'),
      );
    }
    return this.semantic.search(query, limit);
  }

  read(ref: string, agent: boolean): unknown {
    const index = this.require();
    const note = this.note(ref, agent);
    return {
      path: note.path,
      title: note.title,
      frontmatter: note.frontmatter,
      tags: note.tags,
      body: note.body.length > NOTE_LIMIT ? `${note.body.slice(0, NOTE_LIMIT)}\n[...]` : note.body,
      links: note.links.map((link) => ({ alvo: link, nota: index.resolve(link)?.path ?? null })),
      embeds: note.embeds,
      backlinks: index.backlinks(note.path, !agent).map((n) => n.path),
    };
  }

  async write(
    path: string,
    content: string,
    mode: string,
    agent: boolean,
  ): Promise<{ path: string }> {
    const rel = this.safePath(path);
    if (agent && !AGENT_WRITABLE.some((prefix) => rel.startsWith(prefix))) {
      throw new RpcError(
        -32002,
        l10n.t(
          'Agents only write to {0} and {1}; ask the user to change {2}',
          AGENT_WRITABLE[0] ?? '',
          AGENT_WRITABLE[1] ?? '',
          rel,
        ),
      );
    }
    const index = this.require();
    if (agent && index.get(rel)?.private)
      throw RpcError.notFound(l10n.t('Note {0} not found', rel));
    const full = join(index.root, rel);
    await mkdir(dirname(full), { recursive: true });
    if (mode === 'acrescentar') {
      const current = await readFile(full, 'utf8').catch(() => '');
      await appendFile(full, `${current && !current.endsWith('\n') ? '\n' : ''}${content}\n`);
    } else {
      await writeFile(full, content.endsWith('\n') ? content : `${content}\n`);
    }
    await index.update(rel);
    return { path: rel };
  }

  async appendDaily(text: string): Promise<{ path: string }> {
    const now = this.clock();
    const path = `Diário/${localDate(now)}.md`;
    const index = this.require();
    const full = join(index.root, path);
    if (!existsSync(full)) {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, `# ${localDate(now)}\n\n`);
    }
    await appendFile(full, `- ${localTime(now)} ${text.replace(/\n/g, ' ')}\n`);
    await index.update(path);
    return { path };
  }

  /** Nota diária de hoje, criada pelo template `Templates/Diário.md` se existir. */
  async daily(): Promise<{ path: string }> {
    const index = this.require();
    const today = localDate(this.clock());
    const path = `Diário/${today}.md`;
    const full = join(index.root, path);
    if (!existsSync(full)) {
      const template = await readFile(join(index.root, 'Templates', 'Diário.md'), 'utf8').catch(
        () => `# {{data}}\n\n`,
      );
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, template.replace(/\{\{\s*(data|date)\s*\}\}/g, today));
      await index.update(path);
    }
    return { path };
  }

  // ---------------------------------------------------------------- playbooks

  playbooks(): PlaybookInfo[] {
    if (!this.index) return [];
    return this.index
      .all()
      .filter((note) => note.path.startsWith('Playbooks/') && note.frontmatter.tipo === 'playbook')
      .map((note) => {
        const fm = note.frontmatter;
        const papeis = fm.papeisFixados;
        return {
          nome: typeof fm.nome === 'string' ? fm.nome : note.title,
          caminho: note.path,
          ...(typeof fm.maestro === 'string' ? { maestro: fm.maestro } : {}),
          ...(typeof fm.entrega === 'string' ? { entrega: fm.entrega } : {}),
          ...(papeis && typeof papeis === 'object' && !Array.isArray(papeis)
            ? { papeisFixados: papeis as Record<string, string> }
            : {}),
          ...(fm.limites !== undefined ? { limites: fm.limites } : {}),
          ...(fm.criterio !== undefined && fm.criterio !== null ? { criterio: fm.criterio } : {}),
          instrucoes: note.body.trim(),
        };
      });
  }

  playbook(nome: string): PlaybookInfo {
    const found = this.playbooks().find((p) => p.nome === nome || p.caminho === nome);
    if (!found) throw RpcError.notFound(l10n.t('Playbook {0} does not exist in Playbooks/', nome));
    return found;
  }

  /** Tarefa a partir de um playbook: o playbook lido agora vale para esta tarefa. */
  taskFromPlaybook(
    playbook: PlaybookInfo,
    base: { titulo: string; repoPath: string; descricao?: string; origem?: string },
  ): Record<string, unknown> {
    const repo = base.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? '';
    const instrucoes = playbook.instrucoes.replace(/\{\{\s*repo\s*\}\}/g, repo);
    return {
      titulo: base.titulo,
      repoPath: base.repoPath,
      descricao: [
        base.descricao,
        `${l10n.t('Follow the playbook "{0}":', playbook.nome)}\n${instrucoes}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      playbook: playbook.nome,
      ...(base.origem ? { origem: base.origem } : {}),
      ...(playbook.maestro ? { maestroProfileId: playbook.maestro } : {}),
      ...(playbook.entrega ? { entrega: playbook.entrega } : {}),
      ...(playbook.papeisFixados ? { papeisFixados: playbook.papeisFixados } : {}),
      ...(playbook.limites !== undefined ? { limites: playbook.limites } : {}),
      ...(playbook.criterio !== undefined ? { criterio: playbook.criterio } : {}),
    };
  }

  /** Tarefa a partir de uma nota (RF-210, origem `nota`). */
  taskFromNote(ref: string, repoPath?: string): Record<string, unknown> {
    const note = this.note(ref, false);
    const fm = note.frontmatter;
    const repo = repoPath ?? (typeof fm.repo === 'string' ? fm.repo : undefined);
    if (!repo)
      throw RpcError.invalidParams(l10n.t('Provide repoPath or put repo: in the note frontmatter'));
    const base = {
      titulo: typeof fm.titulo === 'string' ? fm.titulo : note.title,
      repoPath: repo,
      descricao: `${note.body.trim()}\n\n${l10n.t('Source note: {0}', `[[${note.path.replace(/\.md$/, '')}]]`)}`,
      origem: 'nota',
    };
    const fromPlaybook: Record<string, unknown> =
      typeof fm.playbook === 'string'
        ? this.taskFromPlaybook(this.playbook(fm.playbook), base)
        : base;
    // O critério da nota se soma ao do playbook em vez de apagá-lo (SDD 9.5).
    const criterio = mergeCriterio(fromPlaybook.criterio, fm.criterio);
    return {
      ...fromPlaybook,
      referencia: note.path,
      ...(criterio !== undefined ? { criterio } : {}),
      ...(typeof fm.entrega === 'string' ? { entrega: fm.entrega } : {}),
      ...(typeof fm.maestro === 'string' ? { maestroProfileId: fm.maestro } : {}),
      ...(fm.limites !== undefined ? { limites: fm.limites } : {}),
    };
  }

  // ---------------------------------------------------------------- notas de execução

  /** Pastas que já existem em `Projetos/`. */
  private async projectFolders(): Promise<string[]> {
    const index = this.require();
    const entries = await readdir(join(index.root, 'Projetos'), { withFileTypes: true }).catch(
      () => [],
    );
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * Uma nota por execução em Agentes/Sessões (RF-406), ligada à memória do
   * projeto: nota-índice `Projetos/<P>/<P>.md`, devlog e diário.
   */
  private async writeRunNote(run: Run): Promise<void> {
    if (!this.index || !this.options.orchestrator) return;
    const task = this.options.orchestrator.taskById(run.taskId);
    if (!task) return;
    const date = new Date(run.inicio);
    const stamp = `${localDate(date)} ${pad(date.getHours())}${pad(date.getMinutes())}`;
    const title = safeFileName(task.titulo);
    const session = `Agentes/Sessões/${stamp} ${title}`;
    const project = projectFolder(task.repoPath, await this.projectFolders());
    const hub = `Projetos/${project}/${project}`;
    const devlog = `Projetos/${project}/Devlog`;
    const tag = projectTag(project);
    const day = localDate(this.clock());
    const totals = this.options.costs?.sessionTotals(run.agentes.map((a) => a.sessionId));
    const decisions = run.decisoes.map(
      (d) =>
        `- ${d.pergunta} → ${d.opcoes.find((o) => o.id === d.escolha)?.rotulo ?? d.escolha ?? l10n.t('no answer')}`,
    );
    const lines = [
      '---',
      'tipo: sessao',
      `tarefa: ${JSON.stringify(task.titulo)}`,
      `projeto: ${JSON.stringify(`[[${hub}|${project}]]`)}`,
      `repo: ${JSON.stringify(task.repoPath)}`,
      `execucao: ${run.id}`,
      `status: ${run.status}`,
      `resultado: ${run.resultado ?? 'nenhum'}`,
      ...(run.branch ? [`branch: ${JSON.stringify(run.branch)}`] : []),
      ...(run.prUrl ? [`pr: ${run.prUrl}`] : []),
      ...(totals
        ? [
            `custoUsd: ${String(totals.custoUsd)}`,
            `tokens: ${String(totals.tokensEntrada + totals.tokensSaida)}`,
          ]
        : []),
      `inicio: ${run.inicio}`,
      ...(run.fim ? [`fim: ${run.fim}`] : []),
      `tags: [fakl/sessao, ${tag}]`,
      '---',
      '',
      `# ${task.titulo}`,
      '',
      l10n.t(
        'Project: {0} · {1} · Daily note: {2}',
        `[[${hub}|${project}]]`,
        `[[${devlog}|Devlog]]`,
        `[[Diário/${day}]]`,
      ),
      '',
      `## ${l10n.t('Request')}`,
      '',
      task.descricao ?? task.titulo,
      '',
      ...(task.referencia
        ? [
            /^https?:\/\//.test(task.referencia)
              ? l10n.t('Source: {0}', task.referencia)
              : l10n.t('Source: {0}', `[[${task.referencia.replace(/\.md$/, '')}]]`),
            '',
          ]
        : []),
      `## ${l10n.t('Agents')}`,
      '',
      ...run.agentes.map(
        (a) =>
          `- ${'  '.repeat(a.profundidade)}${a.profileId} (${a.papel})${a.branch ? ` · \`${a.branch}\`` : ''}`,
      ),
      '',
      `## ${l10n.t('Rounds')}`,
      '',
      ...(run.rodadas.length === 0
        ? [l10n.t('None.')]
        : run.rodadas.map(
            (r) =>
              `- ${l10n.t('Round {0}: {1}', String(r.numero), r.veredito ?? '?')}${r.verificacoes.map((c) => ` · \`${c.nome}\` ${c.ok ? '✓' : '✗'}`).join('')}`,
          )),
      '',
      `## ${l10n.t('Decisions')}`,
      '',
      ...(decisions.length === 0 ? [l10n.t('None.')] : decisions),
      '',
      `## ${l10n.t('Result')}`,
      '',
      run.resumo ?? run.motivo ?? run.status,
      ...(run.prUrl ? ['', `PR: ${run.prUrl}`] : []),
      ...(run.branch ? ['', `Branch: \`${run.branch}\``] : []),
      '',
    ];
    const redact = (text: string): string => this.options.redact?.(text) ?? text;
    await this.write(`${session}.md`, redact(lines.join('\n')), 'substituir', false);

    const outcome = run.resultado && run.resultado !== 'descartado' ? run.resultado : run.status;
    const sessionLink = `[[${session}|${localDate(date)} ${title}]]`;
    await this.upsertNote(
      hub,
      () => this.hubTemplate(project, task.repoPath, tag),
      (text) => upsertInSection(text, 'Sessões', `- ${sessionLink} — ${outcome}`, `[[${session}|`),
    );

    // Resumo do maestro sem títulos de nível 1 e 2, que cortariam a entrada.
    const summary = (run.resumo ?? run.motivo ?? run.status).replace(/^#{1,2} /gm, '### ');
    const marker = `<!-- execucao: ${run.id} -->`;
    const entry = [
      `## ${localDate(date)} ${localTime(date)} — ${task.titulo}`,
      marker,
      '',
      `- ${l10n.t('Result: {0} · session: {1}', outcome, sessionLink)}`,
      ...(run.branch ? [`- Branch: \`${run.branch}\``] : []),
      ...(run.prUrl ? [`- PR: ${run.prUrl}`] : []),
      '',
      summary,
      ...(decisions.length > 0 ? ['', l10n.t('Decisions:'), ...decisions] : []),
    ].join('\n');
    await this.upsertNote(
      devlog,
      () =>
        [
          '---',
          'tipo: devlog',
          `projeto: ${JSON.stringify(`[[${hub}|${project}]]`)}`,
          `tags: [fakl/devlog, ${tag}]`,
          '---',
          '',
          `# Devlog — ${project}`,
          '',
          l10n.t(
            'One entry per task run, the newest at the end. Project: {0}.',
            `[[${hub}|${project}]]`,
          ),
          '',
        ].join('\n'),
      (text) => upsertBlock(text, marker, redact(entry)),
    );

    const daily = await readFile(join(this.require().root, `Diário/${day}.md`), 'utf8').catch(
      () => '',
    );
    if (!daily.includes(`[[${session}|`)) {
      await this.appendDaily(
        redact(l10n.t('{0} in {1} — {2}', sessionLink, `[[${hub}|${project}]]`, outcome)),
      );
    }
  }

  /** Lê a nota (ou o modelo, se não existe), aplica `change` e grava. */
  private async upsertNote(
    path: string,
    template: () => string,
    change: (text: string) => string,
  ): Promise<void> {
    const full = join(this.require().root, `${path}.md`);
    const current = existsSync(full) ? await readFile(full, 'utf8') : template();
    const next = change(current);
    if (next !== current || !existsSync(full)) await this.write(path, next, 'substituir', false);
  }

  /** Nota-índice de um projeto novo, com as notas que já existem na pasta. */
  private hubTemplate(project: string, repoPath: string, tag: string): string {
    const prefix = `Projetos/${project}/`;
    const notes = this.require()
      .all()
      .filter((note) => note.path.startsWith(prefix) && !note.private)
      .map((note) => note.path.replace(/\.md$/, ''))
      .filter((path) => path !== `${prefix}${project}` && path !== `${prefix}Devlog`)
      .sort()
      .map((path) => `- [[${path}|${path.slice(prefix.length)}]]`);
    return [
      '---',
      'tipo: projeto',
      `repo: ${JSON.stringify(repoPath)}`,
      `tags: [fakl/projeto, ${tag}]`,
      '---',
      '',
      `# ${project}`,
      '',
      l10n.t('Repository: {0} · {1}', `\`${repoPath}\``, `[[${prefix}Devlog|Devlog]]`),
      '',
      // Os títulos da nota-índice ficam em pt-BR: o maestro e `upsertInSection` os procuram pelo nome.
      '## Notas',
      '',
      ...(notes.length > 0 ? notes : [l10n.t('None.')]),
      '',
      '## Decisões (ADRs)',
      '',
      l10n.t('None.'),
      '',
      '## Sessões',
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------- API

  register(router: Router): void {
    const isAgent = (context: CallContext): boolean => context.principal !== undefined;
    router.register('vault.status', () => this.status());
    router.register('vault.search', (params, context) => {
      const p = objectParams(params);
      const query = typeof p.consulta === 'string' ? p.consulta : stringParam(p, 'query');
      const limit = typeof p.limite === 'number' ? Math.min(p.limite, 100) : 30;
      return this.search(query, limit, isAgent(context));
    });
    router.register('vault.semanticSearch', (params) => {
      const p = objectParams(params);
      const query = typeof p.consulta === 'string' ? p.consulta : stringParam(p, 'query');
      const limit = typeof p.limite === 'number' ? Math.min(p.limite, 100) : 20;
      return this.semanticSearch(query, limit);
    });
    router.register('vault.read', (params, context) => {
      const p = objectParams(params);
      return this.read(
        typeof p.nota === 'string' ? p.nota : stringParam(p, 'path'),
        isAgent(context),
      );
    });
    router.register('vault.backlinks', (params, context) => {
      const p = objectParams(params);
      const note = this.note(
        typeof p.nota === 'string' ? p.nota : stringParam(p, 'path'),
        isAgent(context),
      );
      return this.require()
        .backlinks(note.path, !isAgent(context))
        .map((n) => ({ path: n.path, title: n.title }));
    });
    router.register('vault.write', (params, context) => {
      const p = objectParams(params);
      const path = typeof p.caminho === 'string' ? p.caminho : stringParam(p, 'path');
      const content = typeof p.conteudo === 'string' ? p.conteudo : stringParam(p, 'content');
      const agent = isAgent(context);
      return this.write(
        path,
        agent ? (this.options.redact?.(content) ?? content) : content,
        p.modo === 'acrescentar' ? 'acrescentar' : 'substituir',
        agent,
      );
    });
    router.register('vault.appendDaily', (params) => {
      const text = stringParam(objectParams(params), 'texto');
      return this.appendDaily(this.options.redact?.(text) ?? text);
    });
    router.register('vault.daily', () => this.daily());
    router.register('vault.graph', () => this.require().graph());
    router.register('vault.tags', () => this.require().tags());
    router.register('vault.sync', () => this.runSync());

    router.register('playbooks.list', () => this.playbooks());
    router.register('playbooks.get', (params) =>
      this.playbook(stringParam(objectParams(params), 'nome')),
    );
    router.register('playbooks.run', async (params) => {
      const orchestrator = this.requireOrchestrator();
      const p = objectParams(params);
      const playbook = this.playbook(stringParam(p, 'nome'));
      const definition = this.taskFromPlaybook(playbook, {
        titulo: typeof p.titulo === 'string' && p.titulo ? p.titulo : playbook.nome,
        repoPath: stringParam(p, 'repoPath'),
        ...(typeof p.objetivo === 'string' ? { descricao: p.objetivo } : {}),
        ...(typeof p.origem === 'string' ? { origem: p.origem } : {}),
      });
      const task = await orchestrator.createTask(definition);
      return { task, run: await orchestrator.startRun(task.id) };
    });
    router.register('tasks.fromNote', async (params) => {
      const orchestrator = this.requireOrchestrator();
      const p = objectParams(params);
      const definition = this.taskFromNote(
        typeof p.nota === 'string' ? p.nota : stringParam(p, 'path'),
        typeof p.repoPath === 'string' ? p.repoPath : undefined,
      );
      const task: Task = await orchestrator.createTask(definition);
      if (p.comecar === true) return { task, run: await orchestrator.startRun(task.id) };
      return { task };
    });
  }

  private requireOrchestrator(): Orchestrator {
    if (!this.options.orchestrator)
      throw RpcError.invalidParams(l10n.t('Orchestrator unavailable'));
    return this.options.orchestrator;
  }
}

/** Há um repositório git na pasta? Usado pela IDE para oferecer a sincronização. */
export async function isGitRepo(path: string): Promise<boolean> {
  return git(['rev-parse', '--is-inside-work-tree'], path).then(
    (out) => out === 'true',
    () => false,
  );
}
