import type { CoreClient } from '@fakl/core';
import { currentLocale, l10n } from '@fakl/i18n';
import type { AgentProfileEntry, Decision, Run, RunStatus, Task, TaskStatus } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { naPasta, pastasLocais } from './escopo.js';
import { recoveryTime } from './recovery-ui.js';
import {
  canOpenMaestro,
  runContext,
  runDescription,
  runStatusLabel,
  taskStatusLabel,
} from './tasks-model.js';
import { tituloDaTarefa, type TarefaDeVoz } from './voz-model.js';

type Node = { kind: 'task'; task: Task } | { kind: 'run'; run: Run; task: Task };

const TASK_ICONS: Record<TaskStatus, string> = {
  nova: 'circle-large-outline',
  executando: 'sync~spin',
  pausada: 'debug-pause',
  concluída: 'pass',
  falhou: 'error',
  cancelada: 'circle-slash',
};

const RUN_ICONS: Record<RunStatus, string> = {
  executando: 'sync~spin',
  pausada: 'debug-pause',
  'aguardando-decisão': 'question',
  concluída: 'pass',
  falhou: 'error',
  descartada: 'trash',
};

const ACTIVE = new Set<RunStatus>(['executando', 'pausada', 'aguardando-decisão']);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tarefas do maestro (SDD 9): criar, acompanhar execuções e responder às
 * decisões que o maestro ou um limite pedem.
 */
export class TasksView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private tasks: Task[] = [];
  private readonly runs = new Map<string, Run>();
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Decisões já mostradas, para não abrir duas vezes o mesmo aviso. */
  private readonly shown = new Set<string>();
  private client: CoreClient | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(router: AgentEventRouter) {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView('fakl.tasks', { treeDataProvider: this }),
      router.listen((event) => {
        if (!event.topic.startsWith('run.') && event.topic !== 'claude.account') return;
        if (event.topic === 'run.decision') void this.showDecision(event.data as Decision);
        if (event.topic === 'run.done') void this.showDone(event.data as Run);
        this.scheduleReload();
      }),
      vscode.commands.registerCommand('fakl.tasks.new', () => this.create()),
      vscode.commands.registerCommand('fakl.maestro.run', (prompt?: unknown) =>
        this.runFromPrompt(typeof prompt === 'string' ? prompt : undefined),
      ),
      vscode.commands.registerCommand('fakl.tasks.start', (node?: Node) => this.start(node)),
      vscode.commands.registerCommand('fakl.tasks.cancel', (node?: Node) => this.cancel(node)),
      vscode.commands.registerCommand('fakl.runs.pause', (node?: Node) =>
        this.control('runs.pause', node),
      ),
      vscode.commands.registerCommand('fakl.runs.resume', (node?: Node) =>
        this.control('runs.resume', node),
      ),
      vscode.commands.registerCommand('fakl.runs.setAutoResume', (node?: Node) =>
        this.setAutoResume(node),
      ),
      vscode.commands.registerCommand('fakl.runs.stop', (node?: Node) =>
        this.control('runs.stop', node),
      ),
      vscode.commands.registerCommand('fakl.runs.openMaestro', (node?: Node) =>
        this.openMaestro(node),
      ),
      vscode.commands.registerCommand('fakl.runs.openPr', (node?: Node) => this.openPr(node)),
      vscode.commands.registerCommand('fakl.decisions.show', () => this.pendingDecisions()),
      vscode.commands.registerCommand('fakl.tasks.refresh', () => this.reload()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload().then(() => this.pendingDecisions(true));
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'task') {
      const { task } = node;
      const item = new vscode.TreeItem(
        task.titulo,
        task.runs.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.id = task.id;
      item.description = taskStatusLabel(task.status);
      item.tooltip = [
        task.descricao,
        l10n.t('Repository: {0}', task.repoPath),
        task.entrega ? l10n.t('Delivery: {0}', task.entrega) : l10n.t('Delivery: default'),
      ]
        .filter(Boolean)
        .join('\n');
      item.iconPath = new vscode.ThemeIcon(TASK_ICONS[task.status]);
      const running = task.runs.some((id) => {
        const status = this.runs.get(id)?.status;
        return status !== undefined && ACTIVE.has(status);
      });
      item.contextValue = running ? 'fakl.task.running' : 'fakl.task';
      return item;
    }
    const { run } = node;
    const item = new vscode.TreeItem(
      l10n.t('Run {0}', new Date(run.inicio).toLocaleString(currentLocale())),
    );
    item.id = run.id;
    item.description = runDescription(run);
    const time = recoveryTime(run.retomada?.retomarEm);
    item.tooltip = [
      run.resumo,
      run.motivo,
      run.retomada && l10n.t('Session limit: {0}', run.retomada.mensagem),
      run.retomada &&
        (run.retomada.automatica
          ? l10n.t('Automatic resume: on')
          : l10n.t('Automatic resume: off')),
      time &&
        (run.retomada?.automatica
          ? l10n.t('Next attempt: {0}', time)
          : l10n.t('Resume available: {0}', time)),
      run.prUrl,
      run.branch && l10n.t('Branch: {0}', run.branch),
    ]
      .filter(Boolean)
      .join('\n');
    item.iconPath = new vscode.ThemeIcon(RUN_ICONS[run.status]);
    item.contextValue = runContext(run);
    if (canOpenMaestro(run)) {
      item.command = {
        command: 'fakl.runs.openMaestro',
        title: l10n.t('Open maestro'),
        arguments: [node],
      };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [...this.tasks]
        .sort((a, b) => b.criadaEm.localeCompare(a.criadaEm))
        .map((task) => ({ kind: 'task', task }));
    }
    if (node.kind === 'task') {
      return node.task.runs
        .flatMap((id) => this.runs.get(id) ?? [])
        .reverse()
        .map((run) => ({ kind: 'run', run, task: node.task }));
    }
    return [];
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 300);
  }

  private async reload(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const folders = pastasLocais(vscode.workspace.workspaceFolders);
      this.tasks = (await client.request<Task[]>('tasks.list')).filter((task) =>
        naPasta(task.repoPath, folders),
      );
      const details = await Promise.all(
        this.tasks
          .filter((task) => task.runs.length > 0)
          .map((task) => client.request<{ runs: Run[] }>('tasks.get', { taskId: task.id })),
      );
      for (const detail of details) for (const run of detail.runs) this.runs.set(run.id, run);
    } catch {
      return;
    }
    this.changed.fire(undefined);
  }

  private require(): CoreClient | undefined {
    if (!this.client) void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
    return this.client;
  }

  private async create(): Promise<void> {
    const client = this.require();
    if (!client) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(l10n.t('Open the repository folder to create a task.'));
      return;
    }
    const title = l10n.t('New task for the maestro');
    const titulo = await vscode.window.showInputBox({
      title,
      prompt: l10n.t('Task title'),
      placeHolder: l10n.t('E.g.: add CSV export to the report'),
      validateInput: (value) => (value.trim() ? undefined : l10n.t('Enter a title')),
    });
    if (!titulo) return;
    const descricao = await vscode.window.showInputBox({
      title,
      prompt: l10n.t('Describe the goal (optional): what needs to be done and any constraints'),
    });
    if (descricao === undefined) return;

    const profiles = await client.request<AgentProfileEntry[]>('profiles.list');
    const modelProfiles = profiles.map((entry) => entry.profile);
    const maestro = await vscode.window.showQuickPick(
      modelProfiles
        .sort((a, b) => Number(b.podeSerMaestro ?? false) - Number(a.podeSerMaestro ?? false))
        .map((profile) => ({
          label: profile.nome,
          description: [
            profile.modelo ?? profile.provedor,
            profile.id,
            profile.podeSerMaestro ? 'maestro' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          id: profile.id,
        })),
      { title, placeHolder: l10n.t('Which model coordinates the task (maestro)?') },
    );
    if (!maestro) return;

    const permittedProfiles = await vscode.window.showQuickPick(
      modelProfiles.map((profile) => ({
        label: profile.nome,
        description: `${profile.modelo ?? profile.provedor} · ${profile.id}`,
        id: profile.id,
        picked: true,
      })),
      {
        title,
        placeHolder: l10n.t(
          'Which models can the maestro call? (select none to prevent delegation)',
        ),
        canPickMany: true,
      },
    );
    if (!permittedProfiles) return;

    const comandos = await vscode.window.showInputBox({
      title,
      prompt: l10n.t('Done criteria: commands that must pass, separated by ";" (optional)'),
      placeHolder: 'pnpm lint; pnpm test',
    });
    if (comandos === undefined) return;

    const entrega = await vscode.window.showQuickPick(
      [
        {
          label: l10n.t('PR + merge into main'),
          description: l10n.t('push and PR merged on GitHub (default)'),
          value: 'pr-merge',
        },
        {
          label: l10n.t('Leave on the branch'),
          description: l10n.t('you review and merge'),
          value: 'branch',
        },
        {
          label: l10n.t('Local merge'),
          description: l10n.t('into the current branch, if it is clean'),
          value: 'merge',
        },
        {
          label: l10n.t('Open PR'),
          description: l10n.t('push the branch and open a PR with gh'),
          value: 'pr',
        },
      ],
      { title, placeHolder: l10n.t('What to do when the criteria pass?') },
    );
    if (!entrega) return;

    const modo = await vscode.window.showQuickPick(
      [
        {
          label: l10n.t('Default'),
          description: l10n.t('from the maestro profile or config.yaml'),
          value: '',
        },
        {
          label: l10n.t('Ask'),
          description: l10n.t('agents ask for permission'),
          value: 'perguntar',
        },
        {
          label: l10n.t('Approve reads'),
          description: l10n.t('reads go through; everything else asks'),
          value: 'aprovar-leitura',
        },
        {
          label: l10n.t('Approve all'),
          description: l10n.t("agents don't ask for permission"),
          value: 'aprovar-tudo',
        },
        {
          label: 'Autopilot',
          description: l10n.t(
            'approves everything, and decisions take the safe option without waiting for you',
          ),
          value: 'autopilot',
        },
      ] as const,
      { title, placeHolder: l10n.t('Permission mode for the task agents') },
    );
    if (!modo) return;

    const lista = comandos
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean);
    try {
      const task = await client.request<Task>('tasks.create', {
        titulo,
        ...(descricao.trim() ? { descricao: descricao.trim() } : {}),
        repoPath: folder.uri.fsPath,
        maestroProfileId: maestro.id,
        perfisPermitidos: permittedProfiles.map((profile) => profile.id),
        entrega: entrega.value,
        ...(modo.value ? { permissoes: modo.value } : {}),
        ...(lista.length > 0 ? { criterio: { comandos: lista } } : {}),
      });
      await this.reload();
      const choice = await vscode.window.showInformationMessage(
        l10n.t('Task "{0}" created.', task.titulo),
        l10n.t('Start now'),
      );
      if (choice) await this.start({ kind: 'task', task });
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not create the task: {0}', message(error)));
    }
  }

  /**
   * Atalho: um texto vira tarefa e o maestro começa na hora, na pasta aberta,
   * sem pedir permissão a cada passo (como `fakl maestro "<tarefa>"`). Quem
   * quer escolher maestro, critério e entrega usa "Nova tarefa".
   */
  private async runFromPrompt(given?: string): Promise<void> {
    if (!this.require()) return;
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    if (!folder) {
      void vscode.window.showWarningMessage(
        l10n.t('Open the repository folder (local, with git) for the maestro to work in.'),
      );
      return;
    }
    const prompt =
      given ??
      (await vscode.window.showInputBox({
        title: 'Maestro',
        prompt: l10n.t(
          'What should the maestro do? It delegates to subagents, checks the work, opens the PR and merges it.',
        ),
        placeHolder: l10n.t('E.g.: fix the login bug and cover it with tests'),
        validateInput: (value) => (value.trim() ? undefined : l10n.t('Describe the task')),
      }));
    if (!prompt?.trim()) return;
    const text = prompt.trim();
    await this.startTask(
      {
        titulo: tituloDaTarefa(text),
        descricao: text,
        origem: 'manual',
        repoPath: folder.uri.fsPath,
        permissoes: 'perguntar',
      },
      true,
    );
  }

  /** Pastas das tarefas conhecidas, para a voz reconhecer o repositório citado. */
  repoPaths(): string[] {
    return [...new Set(this.tasks.map((task) => task.repoPath))];
  }

  /**
   * Cria a tarefa e, com `comecar`, inicia a execução e abre o chat do
   * maestro. Usado pelo atalho do maestro e pelos pedidos por voz; devolve
   * false se o Core recusou. `criada` guarda o id da tarefa já criada: se
   * `runs.start` falhar, uma nova tentativa não cria a tarefa de novo.
   */
  async startTask(
    params: TarefaDeVoz,
    comecar: boolean,
    criada: { id?: string; titulo?: string } = {},
  ): Promise<boolean> {
    const client = this.require();
    if (!client) return false;
    try {
      if (!criada.id) {
        const nova = await client.request<Task>('tasks.create', params);
        criada.id = nova.id;
        criada.titulo = nova.titulo;
      }
      const task = { id: criada.id, titulo: criada.titulo ?? params.titulo };
      if (!comecar) {
        await this.reload();
        void vscode.window.showInformationMessage(l10n.t('Task "{0}" created.', task.titulo));
        return true;
      }
      const run = await client.request<Run>('runs.start', { taskId: task.id });
      this.runs.set(run.id, run);
      await this.reload();
      if (run.maestroSessionId) {
        await vscode.commands.executeCommand('fakl.chat.open', { sessionId: run.maestroSessionId });
      }
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('The maestro could not start: {0}', message(error)),
      );
      return false;
    }
  }

  private async pickTask(node: Node | undefined, placeHolder: string): Promise<Task | undefined> {
    if (node) return node.task;
    const picked = await vscode.window.showQuickPick(
      this.tasks.map((task) => ({
        label: task.titulo,
        description: taskStatusLabel(task.status),
        task,
      })),
      { placeHolder },
    );
    return picked?.task;
  }

  private async start(node?: Node): Promise<void> {
    const client = this.require();
    const task = await this.pickTask(node, l10n.t('Which task to start?'));
    if (!client || !task) return;
    try {
      const run = await client.request<Run>('runs.start', { taskId: task.id });
      this.runs.set(run.id, run);
      await this.reload();
      if (run.maestroSessionId) {
        await vscode.commands.executeCommand('fakl.chat.open', { sessionId: run.maestroSessionId });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not start: {0}', message(error)));
    }
  }

  private async cancel(node?: Node): Promise<void> {
    const client = this.require();
    const task = await this.pickTask(node, l10n.t('Which task to cancel?'));
    if (!client || !task) return;
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Cancel "{0}"? The agents stop and the run branches are deleted.', task.titulo),
      { modal: true },
      l10n.t('Cancel task'),
    );
    if (!choice) return;
    await client.request('tasks.cancel', { taskId: task.id }).catch((error: unknown) => {
      void vscode.window.showErrorMessage(message(error));
    });
    await this.reload();
  }

  private async control(
    method: 'runs.pause' | 'runs.resume' | 'runs.stop',
    node?: Node,
  ): Promise<void> {
    const client = this.require();
    if (!client || node?.kind !== 'run') return;
    try {
      await client.request(method, { runId: node.run.id });
    } catch (error) {
      void vscode.window.showErrorMessage(message(error));
    }
    await this.reload();
  }

  private async openMaestro(node?: Node): Promise<void> {
    if (node?.kind !== 'run' || !node.run.maestroSessionId) return;
    await vscode.commands.executeCommand('fakl.chat.open', {
      sessionId: node.run.maestroSessionId,
    });
  }

  private async setAutoResume(node?: Node): Promise<void> {
    const client = this.require();
    if (!client || node?.kind !== 'run') return;
    const run = this.runs.get(node.run.id) ?? node.run;
    if (!run.retomada) return;
    try {
      await client.request('runs.setAutoResume', {
        runId: run.id,
        automatica: !run.retomada.automatica,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(message(error));
    }
    await this.reload();
  }

  private async openPr(node?: Node): Promise<void> {
    if (node?.kind === 'run' && node.run.prUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(node.run.prUrl));
    }
  }

  private async showDecision(decision: Decision): Promise<void> {
    if (decision.escolha !== undefined || this.shown.has(decision.id)) return;
    this.shown.add(decision.id);
    const labels = decision.opcoes.map((option) => option.rotulo);
    const choice = await vscode.window.showWarningMessage(decision.pergunta, ...labels);
    if (!choice) {
      // Fechou o aviso: a decisão continua pendente em "Decisões pendentes".
      this.shown.delete(decision.id);
      return;
    }
    const option = decision.opcoes.find((o) => o.rotulo === choice);
    if (!option || !this.client) return;
    await this.client
      .request('runs.decide', {
        runId: decision.runId,
        decisionId: decision.id,
        escolha: option.id,
        origem: 'ide',
      })
      .catch((error: unknown) => {
        // Outra tela (celular, CLI) pode ter respondido antes.
        void vscode.window.showInformationMessage(message(error));
      });
  }

  private async pendingDecisions(quiet = false): Promise<void> {
    const client = quiet ? this.client : this.require();
    if (!client) return;
    const pending = await client.request<Decision[]>('runs.decisions').catch(() => []);
    if (pending.length === 0) {
      if (!quiet) void vscode.window.showInformationMessage(l10n.t('No pending decisions.'));
      return;
    }
    for (const decision of pending) void this.showDecision(decision);
  }

  private async showDone(run: Run): Promise<void> {
    const task = this.tasks.find((t) => t.id === run.taskId);
    const name = task?.titulo ?? l10n.t('Task');
    if (run.status === 'concluída') {
      const done =
        run.resultado === 'merge'
          ? run.prUrl
            ? l10n.t('"{0}" finished: PR merged.', name)
            : l10n.t('"{0}" finished: merged into your branch.', name)
          : run.resultado === 'pr'
            ? l10n.t('"{0}" finished with a PR open.', name)
            : l10n.t('"{0}" finished on branch {1}.', name, run.branch);
      const openPr = l10n.t('Open PR');
      const viewBuild = l10n.t('View build');
      const actions = [...(run.prUrl ? [openPr] : []), ...(run.buildUrl ? [viewBuild] : [])];
      const choice = await vscode.window.showInformationMessage(
        `${done}${run.motivo ? ` ${run.motivo}` : ''}`,
        ...actions,
      );
      const url = choice === viewBuild ? run.buildUrl : choice ? run.prUrl : undefined;
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (run.status === 'descartada') {
      void vscode.window.showInformationMessage(
        l10n.t('"{0}" was discarded: {1}', name, run.motivo ?? ''),
      );
    } else {
      const reason = run.motivo ?? run.resumo ?? runStatusLabel(run.status);
      void vscode.window.showWarningMessage(
        run.prUrl
          ? l10n.t('"{0}" did not finish: {1} (draft: {2})', name, reason, run.prUrl)
          : l10n.t('"{0}" did not finish: {1}', name, reason),
      );
    }
  }
}
