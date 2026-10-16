import { randomBytes } from 'node:crypto';

import type { CoreClient, VaultStatus } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  CoreMethod,
  DailyCap,
  EmailAccountRef,
  HostingerStatus,
  PermissionPolicyName,
  ProvidersDetectResult,
  RemoteStatus,
  ResourceSource,
  SshHostInfo,
  VozStatus,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import { addCliToSystemPath, cliOnPath } from './cli.js';
import {
  contextKeys,
  EMPTY_PROGRESS,
  isSetupStepId,
  providerCommand,
  setupView,
  THEME_NAME,
  withStep,
  type SetupProgress,
  type SetupSnapshot,
} from './setup-model.js';
import type {
  FromSetup,
  ProviderActionId,
  SetupStepId,
  SetupView,
  ToSetup,
} from './setup-protocol.js';

const PROGRESS = 'fakl.setup.progresso';
const SEEN = 'fakl.setup.visto';
const RELAY_GUIDE = 'https://github.com/FaKL-Code/FaKL-Code-IDE/blob/main/packages/relay/README.md';
/** O que `github.status` responde (só o que a jornada usa). */
interface GitHubStatus {
  readonly conectado: boolean;
  readonly usuario?: string;
}

/** Uma resposta lenta (a Hostinger consulta a API) não segura a tela inteira. */
const CALL_TIMEOUT_MS = 8_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('sem resposta'));
    }, CALL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Jornada de configuração: um painel com as etapas (todas puláveis), que lê o
 * estado real de cada coisa e configura pelos mesmos comandos do resto da
 * IDE. Abre sozinha na primeira abertura de quem nunca usou a IDE; depois,
 * pelo comando "FaKL: Configurar" ou pelo walkthrough. As context keys
 * `fakl.setup.<etapa>` marcam o walkthrough.
 */
export class SetupUi implements vscode.Disposable {
  private client: CoreClient | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private abrir: SetupStepId | undefined;
  private last: SetupSnapshot | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables = [
      vscode.commands.registerCommand('fakl.setup.open', (step?: unknown) => {
        this.open(isSetupStepId(step) ? step : undefined);
      }),
      // Login no terminal, chave colada, tema trocado: relê quando a pessoa volta.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this.panel) void this.refresh();
      }),
      vscode.window.onDidCloseTerminal(() => {
        if (this.panel) void this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('workbench.colorTheme') ||
          event.affectsConfiguration('fakl.sync.repository')
        ) {
          void this.refresh();
        }
      }),
    ];
    void this.refresh();
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.refresh();
  }

  disconnected(): void {
    this.client = undefined;
    void this.refresh();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /**
   * Na primeira abertura de quem nunca usou a IDE, abre a jornada uma vez.
   * Quem já usava (atualizou a IDE) só a encontra pelo comando e pelo walkthrough.
   */
  openOnFirstRun(existingUser: boolean): void {
    if (this.context.globalState.get<boolean>(SEEN)) return;
    void this.context.globalState.update(SEEN, true);
    if (!existingUser) this.open();
  }

  private get progress(): SetupProgress {
    return this.context.globalState.get<SetupProgress>(PROGRESS, EMPTY_PROGRESS);
  }

  private async saveProgress(progress: SetupProgress): Promise<void> {
    await this.context.globalState.update(PROGRESS, progress);
  }

  private open(step?: SetupStepId): void {
    this.abrir = step;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.refresh();
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'setup');
    const panel = vscode.window.createWebviewPanel(
      'fakl.setup',
      l10n.t('Set up FaKL-Code'),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agents.svg');
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((msg: FromSetup) => {
      this.handle(msg).catch((error: unknown) => {
        void vscode.window.showErrorMessage(message(error));
      });
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  // ---------------------------------------------------------------- estado

  /** Relê tudo; pedidos que chegam durante uma leitura viram uma leitura a mais. */
  private refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.last = await this.snapshot();
        await this.render();
      } while (this.pending());
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Um pedido de releitura chegou durante a leitura (o campo muda entre os awaits). */
  private pending(): boolean {
    return this.again;
  }

  private async snapshot(): Promise<SetupSnapshot> {
    const tema = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    const sync = vscode.workspace.getConfiguration('fakl.sync').get<string>('repository', '');
    const base = {
      conectado: this.client !== undefined,
      idioma: vscode.env.language,
      cliNoPath: cliOnPath(),
      ...(tema ? { tema } : {}),
      ...(sync ? { sync } : {}),
    };
    const client = this.client;
    if (!client) return base;
    const call = <T>(method: CoreMethod, params?: unknown): Promise<T | undefined> =>
      withTimeout(client.request<T>(method, params)).catch(() => undefined);
    const [
      provedores,
      permissoes,
      tetos,
      github,
      fontes,
      vault,
      ssh,
      hostinger,
      lovable,
      email,
      remoto,
      voz,
    ] = await Promise.all([
      call<ProvidersDetectResult>('providers.detect'),
      call<{ permissoes: PermissionPolicyName }>('config.permissions.get'),
      call<Record<string, DailyCap>>('costs.limits.get'),
      call<GitHubStatus>('github.status'),
      call<ResourceSource[]>('sources.list'),
      call<VaultStatus>('vault.status'),
      call<SshHostInfo[]>('ssh.hosts.list'),
      call<HostingerStatus>('hostinger.status'),
      call<unknown[]>('lovable.list'),
      call<EmailAccountRef[]>('email.accounts'),
      call<RemoteStatus>('remote.status'),
      call<VozStatus>('voz.status'),
    ]);
    return {
      ...base,
      ...(provedores ? { provedores: provedores.provedores } : {}),
      ...(permissoes ? { permissoes: permissoes.permissoes } : {}),
      ...(tetos ? { tetos } : {}),
      ...(github
        ? {
            github: {
              conectado: github.conectado,
              ...(github.usuario ? { usuario: github.usuario } : {}),
            },
          }
        : {}),
      ...(fontes ? { fontes: fontes.length } : {}),
      ...(vault
        ? { vault: { ativo: vault.ativo, ...(vault.caminho ? { caminho: vault.caminho } : {}) } }
        : {}),
      ...(ssh ? { sshHosts: ssh.length } : {}),
      ...(hostinger ? { hostinger: { conectado: hostinger.conectado } } : {}),
      ...(lovable ? { lovable: lovable.length } : {}),
      ...(email ? { email: email.length } : {}),
      ...(remoto
        ? {
            remoto: {
              aparelhos: remoto.aparelhos,
              ...(remoto.relay ? { relay: remoto.relay } : {}),
            },
          }
        : {}),
      ...(voz
        ? { voz: { configurado: voz.configurado, ...(voz.modo ? { modo: voz.modo } : {}) } }
        : {}),
    };
  }

  private view(): SetupView {
    return setupView(
      this.last ?? { conectado: false, cliNoPath: false },
      this.progress,
      this.abrir,
    );
  }

  private async render(): Promise<void> {
    const view = this.view();
    for (const [key, value] of Object.entries(contextKeys(view.etapas))) {
      await vscode.commands.executeCommand('setContext', key, value);
    }
    if (this.panel) {
      const update: ToSetup = { type: 'view', view };
      await this.panel.webview.postMessage(update);
    }
  }

  // ---------------------------------------------------------------- ações

  private async handle(msg: FromSetup): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.render();
        this.abrir = undefined;
        return;
      case 'acao':
        await this.runAction(msg.etapa, msg.acao);
        await this.refresh();
        return;
      case 'provedor':
        await this.providerAction(msg.acao, msg.id);
        await this.refresh();
        return;
      case 'detectar':
        // Quem ficou pronto agora (login no terminal, servidor local aberto) ganha perfis.
        await this.client?.request('providers.generateProfiles', {}).catch(() => undefined);
        await this.refresh();
        return;
      case 'pular':
        if (!isSetupStepId(msg.etapa)) return;
        await this.saveProgress(withStep(this.progress, 'puladas', msg.etapa));
        await this.render();
        return;
      case 'interesses':
        await this.saveProgress({ ...this.progress, interesses: msg.ids.filter(isSetupStepId) });
        await this.render();
        return;
      case 'permissoes':
        if (!this.client) return;
        await this.client.request('config.permissions.set', { permissoes: msg.modo });
        await this.saveProgress(withStep(this.progress, 'feitas', 'permissoes'));
        await this.refresh();
        return;
      case 'teto':
        if (!this.client) return;
        await this.client.request('costs.limits.set', {
          provedor: msg.provedor,
          ...(msg.custoUsd !== null && msg.custoUsd > 0 ? { custoUsd: msg.custoUsd } : {}),
        });
        await this.refresh();
        return;
      case 'concluir':
        this.panel?.dispose();
        void vscode.window.showInformationMessage(
          l10n.t(
            'All set. To come back to the setup, run "FaKL: Set up" from the Command Palette.',
          ),
        );
        return;
    }
  }

  private async runAction(step: SetupStepId, action: string): Promise<void> {
    if (!isSetupStepId(step)) return;
    // Só roda o que a própria tela ofereceu para esta etapa: a página não escolhe comandos.
    const offered = this.view()
      .etapas.find((candidate) => candidate.id === step)
      ?.acoes.some((candidate) => candidate.id === action);
    if (!offered) return;
    const done = (): Promise<void> => this.saveProgress(withStep(this.progress, 'feitas', step));
    switch (action) {
      case 'idioma.manter':
        await done();
        return;
      case 'workbench.action.configureLocale':
        // O VS Code pede para reiniciar ao trocar; a etapa já conta como vista.
        await done();
        await vscode.commands.executeCommand(action);
        return;
      case 'tema.aplicar':
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', THEME_NAME, vscode.ConfigurationTarget.Global);
        await done();
        return;
      case 'workbench.action.selectTheme': {
        const config = (): string | undefined =>
          vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
        const before = config();
        await vscode.commands.executeCommand(action);
        if (config() !== before) await done();
        return;
      }
      case 'remoto.guia':
        await vscode.env.openExternal(vscode.Uri.parse(RELAY_GUIDE));
        return;
      case 'fakl.cli.addToPath':
        if (await addCliToSystemPath()) await done();
        return;
      case 'fakl.settings.import':
        // A importação é de outra extensão e não diz se terminou; contar a ida já basta.
        await vscode.commands.executeCommand(action);
        await done();
        return;
      default:
        await vscode.commands.executeCommand(action);
    }
  }

  private async providerAction(action: ProviderActionId, id: string): Promise<void> {
    const status = this.last?.provedores?.find((candidate) => candidate.id === id);
    if (!status) return;
    if (action === 'chave') {
      await vscode.commands.executeCommand('fakl.providers.setKey', id);
      return;
    }
    if (action === 'removerChave') {
      await vscode.commands.executeCommand('fakl.providers.removeKey');
      return;
    }
    const command = providerCommand(status, action);
    if (!command) return;
    // O comando vai digitado, sem Enter: a pessoa confere e roda.
    const terminal = vscode.window.createTerminal({ name: `FaKL: ${status.nome}` });
    terminal.show();
    terminal.sendText(command, false);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'setup.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'setup.css'));
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
<title>${l10n.t('Set up FaKL-Code')}</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
