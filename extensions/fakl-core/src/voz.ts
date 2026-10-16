import { randomBytes } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  AgentProfileEntry,
  VozConfigurarParams,
  VozModo,
  VozStatus,
  VozTranscreverParams,
  VozTranscreverResult,
} from '@fakl/protocol';
import type { ContextoDeVoz, PedidoDeVoz } from '@fakl/voz';
import * as vscode from 'vscode';

import type { AgentControl, AgentEventRouter } from './agents.js';
import type { ChatViewProvider } from './chat.js';
import type { TasksView } from './tasks.js';
import {
  type AcaoDeVoz,
  acaoDoPedido,
  avisoNavegadorNaIde,
  modosDeVoz,
  nomeDoModo,
  perfisDeVoz,
  problemaNoEndpoint,
  reposDeVoz,
  vozNaIde,
} from './voz-model.js';
import type { FromFalar, FromVoz, ToFalar, ToVoz } from './voz-protocol.js';

const STORED_TOKEN = 'fakl.voz.token';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Comandos por voz (ADR 0031). A voz começa desligada; "Configurar voz"
 * escolhe o modo (navegador do celular, OpenAI, Groq ou servidor local) e o
 * grava pelo Core (`voz.configurar`) em `voz:` no ~/.fakl/config.yaml. A
 * chave do provedor fica no SecretStorage da IDE e vai ao Core em memória
 * como `voz.token`, como as da Hostinger e do GitHub. Os webviews gravam o
 * microfone e mandam o áudio para cá; o Core transcreve. "Falar um pedido"
 * abre um painel que grava, mostra o pedido interpretado e o executa como
 * tarefa, conversa nova ou mensagem para a conversa aberta no chat.
 */
export class VozUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<VozStatus | undefined>();
  private client: CoreClient | undefined;
  private current: VozStatus | undefined;
  private panel: vscode.WebviewPanel | undefined;
  /** Tarefa já criada pelo último pedido; a nova tentativa não a duplica. */
  private tarefaCriada: { chave: string; criada: { id?: string; titulo?: string } } | undefined;
  /** O chat é criado depois (ele também usa a voz); a extensão liga os dois. */
  chat: ChatViewProvider | undefined;

  /** Status mudou; `undefined` quando o Core caiu. */
  readonly onDidChangeStatus = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agents: AgentControl,
    private readonly tasks: TasksView,
    router: AgentEventRouter,
  ) {
    this.disposables.push(
      this.changed,
      context.secrets.onDidChange((event) => {
        if (event.key === STORED_TOKEN) void this.push();
      }),
      router.listen((event) => {
        if (event.topic === 'config.changed') void this.refresh();
      }),
      vscode.commands.registerCommand('fakl.voz.falar', () => this.falar()),
      vscode.commands.registerCommand('fakl.voz.configurar', () => this.configurar()),
    );
  }

  get status(): VozStatus | undefined {
    return this.current;
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.push();
  }

  disconnected(): void {
    this.client = undefined;
    this.current = undefined;
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Entrega a chave ao Core e relê o status. */
  private async push(): Promise<void> {
    if (!this.client) return;
    const token = await this.context.secrets.get(STORED_TOKEN);
    await this.client
      .request('secrets.set', { nome: 'voz.token', valor: token ?? null })
      .catch(() => undefined);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.client) return;
    this.current = await this.client
      .request<VozStatus>('voz.status')
      .catch((error: unknown) => ({ configurado: false, motivo: message(error) }));
    this.changed.fire(this.current);
  }

  /** Mensagens de voz de qualquer webview; a resposta vai por `post`. */
  async handle(msg: FromVoz, post: (reply: ToVoz) => void): Promise<void> {
    if (msg.type === 'vozConfigurar') {
      await vscode.commands.executeCommand('fakl.voz.configurar');
      return;
    }
    try {
      const client = this.client;
      if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
      const params: VozTranscreverParams = { audio: msg.audio, mime: msg.mime, idioma: 'pt-BR' };
      const { texto } = await client.request<VozTranscreverResult>('voz.transcrever', params);
      post({ type: 'vozTexto', requestId: msg.requestId, texto });
    } catch (error) {
      post({
        type: 'vozErro',
        requestId: msg.requestId,
        mensagem: l10n.t("Couldn't transcribe: {0}", message(error)),
      });
    }
  }

  // --- Configurar voz -----------------------------------------------------------------

  /** Escolhe (ou troca) o modo de voz; também desliga. */
  private async configurar(): Promise<void> {
    const title = l10n.t('Set up voice');
    const client = this.client;
    if (!client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    if (!this.current) await this.refresh();
    const atual = this.current?.modo;
    type Item = vscode.QuickPickItem & { modo: VozModo | null };
    const itens: Item[] = modosDeVoz().map((m) => ({
      label: m.nome,
      description: m.id === atual ? l10n.t('(current)') : '',
      detail: m.descricao,
      modo: m.id,
    }));
    if (atual) itens.push({ label: `$(circle-slash) ${l10n.t('Turn off voice')}`, modo: null });
    const escolhido = await vscode.window.showQuickPick(itens, {
      title,
      placeHolder: atual
        ? l10n.t('Current mode: {0}. What should recognize your speech?', nomeDoModo(atual))
        : l10n.t('Voice is off. What should recognize your speech?'),
    });
    if (!escolhido) return;
    const params = await this.perguntarDetalhes(escolhido.modo, title);
    if (!params) return;
    try {
      this.current = await client.request<VozStatus>('voz.configurar', params);
      this.changed.fire(this.current);
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't set up voice: {0}", message(error)));
      return;
    }
    await this.push();
    // push() relê o status: o que veio de voz.configurar já pode ter mudado.
    const status = this.status;
    if (params.modo === null) {
      void vscode.window.showInformationMessage(l10n.t('Voice turned off.'));
    } else if (!status?.configurado) {
      void vscode.window.showWarningMessage(
        status?.motivo
          ? l10n.t(
              "Voice: {0}, but it isn't ready yet ({1}).",
              nomeDoModo(params.modo),
              status.motivo,
            )
          : l10n.t("Voice: {0}, but it isn't ready yet.", nomeDoModo(params.modo)),
      );
    } else if (params.modo === 'navegador') {
      void vscode.window.showInformationMessage(
        l10n.t('Voice: {0}. {1}', nomeDoModo('navegador'), avisoNavegadorNaIde()),
      );
    } else {
      void vscode.window.showInformationMessage(
        l10n.t('Voice ready: {0}.', nomeDoModo(params.modo)),
      );
    }
  }

  /** Chave (no cofre) e, no servidor local, endereço e modelo; `undefined` se cancelou. */
  private async perguntarDetalhes(
    modo: VozModo | null,
    title: string,
  ): Promise<VozConfigurarParams | undefined> {
    if (modo === null || modo === 'navegador') return { modo };
    const { nome, chave: pedeChave } = modosDeVoz().find((m) => m.id === modo) ?? {
      nome: modo,
      chave: 'opcional' as const,
    };
    let endpoint: string | undefined;
    let modelo: string | undefined;
    if (modo === 'local') {
      const anterior = this.current?.modo === 'local' ? this.current : undefined;
      endpoint = await vscode.window.showInputBox({
        title,
        prompt: l10n.t('Address of the OpenAI API-compatible server (route /audio/transcriptions)'),
        value: anterior?.endpoint ?? 'http://127.0.0.1:8000/v1',
        ignoreFocusOut: true,
        validateInput: (value) => problemaNoEndpoint(value),
      });
      if (endpoint === undefined) return undefined;
      modelo = await vscode.window.showInputBox({
        title,
        prompt: l10n.t('Model the server uses (e.g. whisper-1, Systran/faster-whisper-small)'),
        value: anterior?.modelo ?? 'whisper-1',
        ignoreFocusOut: true,
      });
      if (modelo === undefined) return undefined;
    }
    const guardada = await this.context.secrets.get(STORED_TOKEN);
    const obrigatoria = pedeChave === 'sim';
    const chave = await vscode.window.showInputBox({
      title,
      prompt: obrigatoria
        ? guardada
          ? l10n.t(
              '{0} API key. It stays in the system keychain, never in a file. Leave empty to keep the current key.',
              nome,
            )
          : l10n.t('{0} API key. It stays in the system keychain, never in a file.', nome)
        : guardada
          ? l10n.t(
              '{0} API key (optional). It stays in the system keychain, never in a file. Leave empty to keep the current key.',
              nome,
            )
          : l10n.t(
              '{0} API key (optional). It stays in the system keychain, never in a file.',
              nome,
            ),
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        obrigatoria && !guardada && !value.trim() ? l10n.t('Paste the API key') : undefined,
    });
    if (chave === undefined) return undefined;
    if (chave.trim()) await this.context.secrets.store(STORED_TOKEN, chave.trim());
    return {
      modo,
      ...(endpoint?.trim() ? { endpoint: endpoint.trim() } : {}),
      ...(modelo?.trim() ? { modelo: modelo.trim() } : {}),
    };
  }

  // --- Falar um pedido ------------------------------------------------------------------

  private async contexto(): Promise<ContextoDeVoz> {
    const entries = await this.client
      ?.request<AgentProfileEntry[]>('profiles.list')
      .catch((): AgentProfileEntry[] => []);
    const pastas = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => ({ caminho: folder.uri.fsPath, nome: folder.name }));
    return {
      perfis: perfisDeVoz((entries ?? []).map((entry) => entry.profile)),
      repos: reposDeVoz([...pastas, ...this.tasks.repoPaths().map((caminho) => ({ caminho }))]),
      conversaAberta: this.chat?.activeSession() !== undefined,
    };
  }

  private async falar(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.init(true);
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'falar');
    const panel = vscode.window.createWebviewPanel(
      'fakl.voz.falar',
      l10n.t('What do you want?'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [media] },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mic.svg');
    panel.webview.html = this.html(panel.webview, media);
    const post = (reply: ToFalar): void => {
      void panel.webview.postMessage(reply);
    };
    const listener = this.onDidChangeStatus((status) => {
      post(status ? { type: 'vozStatus', status } : { type: 'vozStatus' });
    });
    panel.webview.onDidReceiveMessage((msg: FromFalar) => {
      switch (msg.type) {
        case 'ready':
          void this.init(true);
          break;
        case 'vozTranscrever':
        case 'vozConfigurar':
          void this.handle(msg, post);
          break;
        case 'enviar':
          void this.enviar(msg.pedido, post);
          break;
        case 'fechar':
          panel.dispose();
          break;
      }
    });
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private async init(gravar: boolean): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    if (!this.current) await this.refresh();
    const status = this.current ?? {
      configurado: false,
      motivo: l10n.t('the FaKL Core is not responding'),
    };
    await panel.webview.postMessage({
      type: 'init',
      contexto: await this.contexto(),
      status,
      gravar: gravar && vozNaIde(status).pronta,
    } satisfies ToFalar);
  }

  private async enviar(pedido: PedidoDeVoz, post: (reply: ToFalar) => void): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    const perfilPadrao = pedido.perfilId
      ? undefined
      : (await this.agents.detect(true)).find((p) => p.availability.status === 'pronto')?.id;
    const sessaoAtiva = this.chat?.activeSession();
    const acao = acaoDoPedido(pedido, {
      ...(folder ? { repoPadrao: folder.uri.fsPath } : {}),
      ...(perfilPadrao ? { perfilPadrao } : {}),
      ...(sessaoAtiva ? { sessaoAtiva } : {}),
    });
    try {
      switch (acao.tipo) {
        case 'erro':
          post({ type: 'erro', mensagem: acao.mensagem });
          return;
        case 'tarefa':
          if (!(await this.tasks.startTask(acao.tarefa, acao.comecar, this.criadaDe(acao)))) {
            post({
              type: 'erro',
              mensagem: l10n.t("The task didn't start. Check the IDE's warning and try again."),
            });
            return;
          }
          this.tarefaCriada = undefined;
          break;
        case 'avulsa':
          await this.chat?.startAndSend(acao.profileId, acao.texto, acao.worktree, acao.repoPath);
          break;
        case 'mensagem':
          await this.chat?.sendTo(acao.sessionId, acao.texto);
          break;
      }
      this.panel?.dispose();
    } catch (error) {
      post({ type: 'erro', mensagem: message(error) });
    }
  }

  /** Registro da tarefa deste pedido: o mesmo pedido repetido reaproveita a tarefa criada. */
  private criadaDe(acao: Extract<AcaoDeVoz, { tipo: 'tarefa' }>): { id?: string; titulo?: string } {
    const chave = JSON.stringify([acao.tarefa, acao.comecar]);
    if (this.tarefaCriada?.chave !== chave) this.tarefaCriada = { chave, criada: {} };
    return this.tarefaCriada.criada;
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'falar.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'falar.css'));
    // O microfone (getUserMedia) não depende do CSP; o áudio gravado só vira
    // base64 e vai ao host, sem tocar no webview, então media-src fica fechado.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>${l10n.t('What do you want?')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
