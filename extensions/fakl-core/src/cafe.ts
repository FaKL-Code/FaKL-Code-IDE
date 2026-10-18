import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { CafeState } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentControl, AgentEventRouter } from './agents.js';
import type { ExternalSessionsFeed } from './externas.js';
import type { FromCafe, ToCafe } from './cafe-protocol.js';
import { moveToNewWindow } from './janelas.js';
import { attachTips } from './tour.js';

/** Eventos que o café anima; o resto chega por `cafe.state`. */
const ANIMATED = new Set(['agent.state', 'agent.thumbnail', 'run.round', 'run.limit', 'run.done']);
/** Eventos que mudam o placar ou a lista de agentes. */
const REFRESH = new Set(['run.done', 'cost.update']);

/**
 * Cyber café (SDD 13): uma sala em pixel art onde cada agente é um avatar num
 * PC. Só consome eventos do Core; o Core gera as miniaturas enquanto a sala
 * está visível, e esconder o painel para tudo (RF-601 a RF-606).
 */
export class CafeUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private client: CoreClient | undefined;
  private open = false;
  private watching: vscode.Disposable | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    router: AgentEventRouter,
    agents: AgentControl,
    private readonly externas: ExternalSessionsFeed,
  ) {
    this.disposables.push(
      externas.onDidChange(() => {
        if (this.open) this.postExternas();
      }),
      vscode.commands.registerCommand('fakl.cafe.open', () => {
        this.show();
      }),
      vscode.commands.registerCommand('fakl.janela.cafe', async () => {
        await moveToNewWindow(this.show());
      }),
      // O café num segundo monitor volta lá quando a IDE reabre.
      vscode.window.registerWebviewPanelSerializer('fakl.cafe', {
        deserializeWebviewPanel: (panel) => {
          this.adopt(panel);
          return Promise.resolve();
        },
      }),
      router.listen((event) => {
        if (!this.open) return;
        if (ANIMATED.has(event.topic)) this.post({ type: 'event', event });
        if (REFRESH.has(event.topic)) this.scheduleRefresh();
      }),
      // Agente novo ou removido não gera evento do Core; sem isto, quem
      // chegava não sentava num PC até reabrir a sala.
      agents.onDidChangeSessions(() => {
        if (this.open) this.scheduleRefresh();
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watching?.dispose();
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    if (this.panel?.visible) void this.openRoom();
  }

  disconnected(): void {
    this.client = undefined;
    this.open = false;
    this.post({ type: 'offline' });
  }

  private show(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal();
      return this.panel;
    }
    // Sem retainContextWhenHidden: escondido, o webview some e não gasta CPU.
    const panel = vscode.window.createWebviewPanel(
      'fakl.cafe',
      l10n.t('Cyber café'),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this.media] },
    );
    this.adopt(panel);
    return panel;
  }

  private get media(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist', 'cafe');
  }

  /** Liga um painel novo ou restaurado ao reabrir a IDE. */
  private adopt(panel: vscode.WebviewPanel): void {
    const previous = this.panel;
    this.panel = panel;
    previous?.dispose();
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'coffee.svg');
    panel.webview.html = this.html(panel.webview, this.media);
    attachTips(panel, 'cafe');
    panel.webview.onDidReceiveMessage((message: FromCafe) => void this.receive(message));
    panel.onDidChangeViewState(() => {
      if (!panel.visible) void this.closeRoom();
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      void this.closeRoom();
    });
  }

  private async receive(message: FromCafe): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.openRoom();
        return;
      case 'refresh':
        this.scheduleRefresh();
        return;
      case 'open':
        await vscode.commands.executeCommand('fakl.chat.open', { sessionId: message.sessionId });
        return;
      case 'externasAbrir':
        await this.externas.open(message.id);
        return;
      case 'newAgent':
        await vscode.commands.executeCommand('fakl.agents.new');
        return;
      case 'newTask':
        await vscode.commands.executeCommand('fakl.tasks.new');
        return;
    }
  }

  private async openRoom(): Promise<void> {
    const client = this.client;
    if (!client) {
      this.post({ type: 'offline' });
      return;
    }
    try {
      const state = await client.request<CafeState>('cafe.open');
      this.open = true;
      this.watching ??= this.externas.watch();
      this.post({ type: 'state', state });
      this.postExternas();
    } catch {
      this.post({ type: 'offline' });
    }
  }

  private async closeRoom(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.watching?.dispose();
    this.watching = undefined;
    clearTimeout(this.refreshTimer);
    await this.client?.request('cafe.close').catch(() => undefined);
  }

  private postExternas(): void {
    this.post({ type: 'externas', ...this.externas.state });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.open || !this.client) return;
      void this.client
        .request<CafeState>('cafe.state')
        .then((state) => {
          this.post({ type: 'state', state });
        })
        .catch(() => undefined);
    }, 500);
  }

  private post(message: ToCafe): void {
    void this.panel?.webview.postMessage(message);
  }

  /** PNGs do café que vieram no build (dist/cafe/assets.json). */
  private assetList(media: vscode.Uri): string {
    try {
      return readFileSync(vscode.Uri.joinPath(media, 'assets.json').fsPath, 'utf8');
    } catch {
      return '[]';
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cafe.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cafe.css'));
    const assets = webview.asWebviewUri(vscode.Uri.joinPath(media, 'assets/'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
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
<title>${l10n.t('Cyber café')}</title>
</head>
<body>
<div id="sala" data-assets="${assets.toString()}" data-files="${escapeAttr(this.assetList(media))}"><canvas id="cena" aria-label="${escapeAttr(l10n.t('Cyber café room with the agents'))}"></canvas><p id="aviso" hidden></p><div id="acoes"><button id="novo-agente" type="button" title="${escapeAttr(l10n.t('Chat with a new agent; it sits down at a PC'))}">${l10n.t('+ Agent')}</button><button id="nova-tarefa" type="button" title="${escapeAttr(l10n.t('Task with a maestro, who calls the agents'))}">${l10n.t('+ Task')}</button></div></div>
<div id="telas" role="list" aria-label="${escapeAttr(l10n.t('Agent screens'))}"></div>
<div id="externas" role="list" aria-label="${escapeAttr(l10n.t('Conversations from other tools'))}" hidden></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
