import { randomBytes } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { CiStatus } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import type { FromCozinha, ToCozinha } from './ci-panel-protocol.js';
import { moveToNewWindow } from './janelas.js';

const SAEM_APOS_SETTING = 'ci.concluidasSaemApos';

/**
 * Cozinha do CI em tela própria (ADR 0053): as execuções do GitHub Actions dos
 * repositórios acompanhados, com as mesmas saídas do café e da Mesa para o que
 * já passou (dispensar uma execução, limpar as concluídas, mostrar de novo). O
 * que sai da tela fica só no webview; o Core continua só lendo o GitHub.
 */
export class CiKitchenUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private client: CoreClient | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    router: AgentEventRouter,
  ) {
    this.disposables.push(
      vscode.commands.registerCommand('fakl.ci.open', () => {
        this.show();
      }),
      vscode.commands.registerCommand('fakl.janela.cozinha', async () => {
        await moveToNewWindow(this.show());
      }),
      vscode.window.registerWebviewPanelSerializer('fakl.ci', {
        deserializeWebviewPanel: (panel) => {
          this.adopt(panel);
          return Promise.resolve();
        },
      }),
      router.listen((event) => {
        if (event.topic === 'ci.run') this.post({ type: 'event', event });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`fakl.${SAEM_APOS_SETTING}`)) this.postConfig();
      }),
    );
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    if (this.panel) void this.sendStatus(false);
  }

  disconnected(): void {
    this.client = undefined;
    this.post({ type: 'offline' });
  }

  private show(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal();
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'fakl.ci',
      l10n.t('CI kitchen'),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this.media] },
    );
    this.adopt(panel);
    return panel;
  }

  private get media(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist', 'cozinha');
  }

  private adopt(panel: vscode.WebviewPanel): void {
    const previous = this.panel;
    this.panel = panel;
    previous?.dispose();
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'coffee.svg');
    panel.webview.html = this.html(panel.webview, this.media);
    panel.webview.onDidReceiveMessage((message: FromCozinha) => void this.receive(message));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private async receive(message: FromCozinha): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postConfig();
        await this.sendStatus(false);
        return;
      case 'atualizar':
        await this.sendStatus(true);
        return;
      case 'acompanhar':
        await vscode.commands.executeCommand('fakl.ci.acompanhar');
        return;
      case 'abrir': {
        const [owner, name] = message.repo.split('/');
        await vscode.commands.executeCommand('fakl.github.openRun', {
          owner,
          name,
          id: message.id,
          url: message.url,
        });
        return;
      }
    }
  }

  private async sendStatus(refresh: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      this.post({ type: 'offline' });
      return;
    }
    try {
      const status = await client.request<CiStatus>(
        'ci.status',
        refresh ? { atualizar: true } : {},
      );
      this.post({ type: 'status', status });
    } catch {
      this.post({ type: 'offline' });
    }
  }

  private postConfig(): void {
    const minutes = vscode.workspace.getConfiguration('fakl').get<number>(SAEM_APOS_SETTING, 60);
    this.post({
      type: 'config',
      saemAposMin: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
    });
  }

  private post(message: ToCozinha): void {
    void this.panel?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cozinha.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cozinha.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} blob:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>${escapeAttr(l10n.t('CI kitchen'))}</title>
</head>
<body>
<header id="barra">
<h1>${escapeAttr(l10n.t('CI kitchen'))}</h1>
<div id="barra-acoes">
<button id="limpar" type="button" title="${escapeAttr(l10n.t('Remove the finished runs from the screen'))}">${escapeAttr(l10n.t('Clear finished runs'))}</button>
<button id="restaurar" type="button" title="${escapeAttr(l10n.t('Bring back the runs that were removed or left on their own'))}" hidden>${escapeAttr(l10n.t('Show removed'))}</button>
<button id="atualizar" type="button" title="${escapeAttr(l10n.t('Ask GitHub for the runs now'))}">${escapeAttr(l10n.t('Refresh now'))}</button>
</div>
</header>
<p id="aviso" role="status" hidden></p>
<main id="conteudo">
<section id="resumo" aria-label="${escapeAttr(l10n.t('Summary of the CI'))}" hidden>
<div class="tile" id="t-verdes"><strong>0</strong><span>${escapeAttr(l10n.t('green in a row'))}</span></div>
<div class="tile" id="t-falhando"><strong>0</strong><span>${escapeAttr(l10n.t('workflows failing'))}</span></div>
<div class="tile" id="t-andamento"><strong>0</strong><span>${escapeAttr(l10n.t('running now'))}</span></div>
<p id="repos"></p>
</section>
<section id="cozinha-bloco" hidden><canvas id="cozinha" role="img" aria-label="${escapeAttr(l10n.t('CI kitchen'))}"></canvas><ul id="ci-presentes" class="so-leitor" aria-label="${escapeAttr(l10n.t('CI runs in the kitchen'))}"></ul></section>
<section id="sec-atencao" hidden><h2>${escapeAttr(l10n.t('Needs attention'))} <small id="n-atencao"></small></h2><div id="ci-atencao" class="ci-grade" role="list" aria-label="${escapeAttr(l10n.t('Runs that need attention'))}"></div></section>
<section id="sec-andamento" hidden><h2>${escapeAttr(l10n.t('Running'))} <small id="n-andamento"></small></h2><div id="ci-andamento" class="ci-grade" role="list" aria-label="${escapeAttr(l10n.t('Runs in progress'))}"></div></section>
<section id="sec-concluidas" hidden><h2>${escapeAttr(l10n.t('Finished'))} <small id="n-concluidas"></small></h2><div id="ci-concluidas" class="ci-grade" role="list" aria-label="${escapeAttr(l10n.t('Finished runs'))}"></div></section>
<div id="vazio" hidden><p id="vazio-texto"></p><button id="acompanhar" type="button">${escapeAttr(l10n.t('Follow a repository'))}</button></div>
</main>
<div id="anuncio" class="so-leitor" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
