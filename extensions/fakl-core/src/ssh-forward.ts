import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { FaklEvent, SshForwardInfo, SshHostInfo } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';

type Node = SshForwardInfo | { readonly t: 'info'; readonly label: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForward(node: Node | undefined): node is SshForwardInfo {
  return node !== undefined && !('t' in node);
}

/** "5432" ou "db.interno:5432": destino (visto do servidor) e porta. */
export function parseTarget(text: string): { destino?: string; portaDestino: number } | undefined {
  const value = text.trim();
  const at = value.lastIndexOf(':');
  const portText = at < 0 ? value : value.slice(at + 1);
  if (!/^[0-9]{1,5}$/.test(portText)) return undefined;
  const portaDestino = Number(portText);
  if (portaDestino < 1 || portaDestino > 65_535) return undefined;
  const destino = at < 0 ? '' : value.slice(0, at);
  return destino ? { destino, portaDestino } : { portaDestino };
}

function stateLabel(info: SshForwardInfo): string {
  switch (info.estado) {
    case 'abrindo':
      return l10n.t('opening');
    case 'ativo':
      return l10n.t('active');
    case 'reconectando':
      return l10n.t('reconnecting ({0})', String(info.tentativas));
    case 'erro':
      return l10n.t('failed');
    case 'fechado':
      return l10n.t('closed');
  }
}

const STATE_ICON: Record<SshForwardInfo['estado'], string> = {
  abrindo: 'loading~spin',
  ativo: 'plug',
  reconectando: 'sync~spin',
  erro: 'error',
  fechado: 'circle-outline',
};

/**
 * Encaminhamentos de porta do SSH nativo (RF-504): árvore "Encaminhamentos" no painel
 * SSH, comandos de abrir, fechar e abrir no navegador, e um item na barra de status
 * enquanto houver algum ativo. Quem gerencia os processos `ssh -N -L` é o Core; aqui só
 * se pede e se mostra. Favoritos fechados nunca reabrem sozinhos: só depois de um "sim".
 */
export class SshForwardsUi implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly item: vscode.StatusBarItem;
  private client: CoreClient | undefined;
  private forwards: SshForwardInfo[] = [];
  private offered = false;
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    router: AgentEventRouter,
    private readonly pickHost: (node?: unknown) => Promise<SshHostInfo | undefined>,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'fakl.ssh.forwards',
      vscode.StatusBarAlignment.Left,
      98,
    );
    this.item.name = l10n.t('FaKL port forwards');
    this.item.command = 'fakl.ssh.forward.menu';
    this.disposables.push(
      this.item,
      this.changed,
      vscode.window.createTreeView('fakl.ssh.forwards', { treeDataProvider: this }),
      router.listen((event: FaklEvent) => {
        if (event.topic === 'ssh.forward') void this.reload(event.data as SshForwardInfo);
      }),
      vscode.commands.registerCommand('fakl.ssh.forward.open', (node?: unknown) => this.open(node)),
      vscode.commands.registerCommand('fakl.ssh.forward.close', (node?: Node) => this.close(node)),
      vscode.commands.registerCommand('fakl.ssh.forward.browser', (node?: Node) =>
        this.browser(node),
      ),
      vscode.commands.registerCommand('fakl.ssh.forward.reopen', (node?: Node) =>
        this.reopen(node),
      ),
      vscode.commands.registerCommand('fakl.ssh.forward.forget', (node?: Node) =>
        this.forget(node),
      ),
      vscode.commands.registerCommand('fakl.ssh.forward.menu', () => this.menu()),
    );
    this.render();
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload().then(() => this.offerFavorites());
  }

  disconnected(): void {
    this.client = undefined;
    this.forwards = [];
    this.offered = false;
    this.render();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async reload(event?: SshForwardInfo): Promise<void> {
    if (!this.client) return;
    const previous = event ? this.forwards.find((f) => f.id === event.id) : undefined;
    this.forwards = await this.client
      .request<SshForwardInfo[]>('ssh.forward.list')
      .catch(() => this.forwards);
    this.render();
    // Quedas que a pessoa não pediu (o erro depois de estar ativo) merecem um aviso.
    if (event?.estado === 'erro' && previous && previous.estado !== 'erro') {
      void vscode.window.showWarningMessage(
        l10n.t('Port forward {0} stopped: {1}', event.id, event.erro ?? ''),
      );
    }
  }

  private render(): void {
    this.changed.fire(undefined);
    const live = this.forwards.filter((f) => f.estado === 'ativo' || f.estado === 'reconectando');
    if (live.length === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(plug) ${String(live.length)}`;
    this.item.tooltip = [
      l10n.t('Active port forwards (click to manage):'),
      ...live.map(
        (f) => `${f.url} -> ${f.host}:${f.destino}:${String(f.portaDestino)} (${stateLabel(f)})`,
      ),
    ].join('\n');
    this.item.show();
  }

  /** Favoritos fechados: o Core nunca os reabre, então a pessoa decide aqui. */
  private async offerFavorites(): Promise<void> {
    if (this.offered) return;
    const closed = this.forwards.filter((f) => f.estado === 'fechado' && f.favorito);
    if (closed.length === 0) return;
    this.offered = true;
    const open = l10n.t('Reopen');
    const answer = await vscode.window.showInformationMessage(
      closed.length === 1
        ? l10n.t('1 favorite port forward is closed: {0}.', closed[0]?.id ?? '')
        : l10n.t('{0} favorite port forwards are closed.', String(closed.length)),
      open,
    );
    if (answer === open) for (const fav of closed) await this.openSaved(fav);
  }

  // ----------------------------------------------------------------- árvore

  getChildren(): Node[] {
    if (!this.client) return [{ t: 'info', label: l10n.t('The FaKL Core is not responding.') }];
    return this.forwards;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (!isForward(node)) return new vscode.TreeItem(node.label);
    const item = new vscode.TreeItem(
      `${String(node.portaLocal)} -> ${node.destino}:${String(node.portaDestino)}`,
    );
    item.description = [node.host, stateLabel(node), node.favorito ? l10n.t('favorite') : '']
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[node.estado]);
    item.contextValue = `fwd-${node.estado}${node.favorito ? '-fav' : ''}`;
    item.tooltip = [
      `${node.url} -> ${node.host}:${node.destino}:${String(node.portaDestino)}`,
      node.erro ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    return item;
  }

  // --------------------------------------------------------------- comandos

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  private async askPort(title: string, value?: string): Promise<number | undefined> {
    const text = await vscode.window.showInputBox({
      title,
      ...(value ? { value } : {}),
      ignoreFocusOut: true,
      validateInput: (input) =>
        /^[0-9]{1,5}$/.test(input) && Number(input) >= 1 && Number(input) <= 65_535
          ? undefined
          : l10n.t('A port from 1 to 65535'),
    });
    return text ? Number(text) : undefined;
  }

  private async open(node?: unknown): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const host = await this.pickHost(node);
    if (!host) return;
    const target = await vscode.window.showInputBox({
      title: l10n.t('Port on {0}', host.alias),
      prompt: l10n.t(
        'The port the service listens on at the host (e.g. 5432), or address:port to reach another machine from it.',
      ),
      ignoreFocusOut: true,
      validateInput: (input) =>
        parseTarget(input)
          ? undefined
          : l10n.t('Use a port (5432) or address:port (db.internal:5432)'),
    });
    const parsed = target ? parseTarget(target) : undefined;
    if (!parsed) return;
    const portaLocal = await this.askPort(
      l10n.t('Local port (opens at 127.0.0.1)'),
      String(parsed.portaDestino),
    );
    if (!portaLocal) return;
    const extras = await vscode.window.showQuickPick(
      [
        {
          id: 'reconectar',
          label: l10n.t('Reconnect automatically if the connection drops'),
        },
        {
          id: 'favorito',
          label: l10n.t('Save as favorite'),
          description: l10n.t('Stays in the list; it only reopens when you ask'),
        },
      ],
      { canPickMany: true, title: l10n.t('Port forward options (optional)') },
    );
    if (!extras) return;
    await this.request(client, {
      host: host.alias,
      portaLocal,
      portaDestino: parsed.portaDestino,
      ...(parsed.destino ? { destino: parsed.destino } : {}),
      reconectar: extras.some((e) => e.id === 'reconectar'),
      favorito: extras.some((e) => e.id === 'favorito'),
    });
  }

  private async request(client: CoreClient, params: Record<string, unknown>): Promise<void> {
    try {
      const info = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: l10n.t('Opening the port forward...'),
        },
        () => client.request<SshForwardInfo>('ssh.forward.open', params),
      );
      void vscode.window
        .showInformationMessage(
          l10n.t('Port {0} on this machine now reaches {1}.', String(info.portaLocal), info.host),
          l10n.t('Open in browser'),
        )
        .then((choice) => (choice ? this.browser(info) : undefined));
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not open the port forward: {0}', message(error)),
      );
    } finally {
      await this.reload();
    }
  }

  private async openSaved(info: SshForwardInfo): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    await this.request(client, {
      host: info.host,
      portaLocal: info.portaLocal,
      portaDestino: info.portaDestino,
      destino: info.destino,
      reconectar: info.reconectar,
      favorito: true,
    });
  }

  private async reopen(node?: Node): Promise<void> {
    if (isForward(node)) await this.openSaved(node);
  }

  private async pickForward(
    node: Node | undefined,
    filter: (f: SshForwardInfo) => boolean,
    title: string,
  ): Promise<SshForwardInfo | undefined> {
    if (isForward(node)) return node;
    const candidates = this.forwards.filter(filter);
    if (candidates.length <= 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((f) => ({
        label: `${String(f.portaLocal)} -> ${f.destino}:${String(f.portaDestino)}`,
        description: f.host,
        forward: f,
      })),
      { title },
    );
    return picked?.forward;
  }

  private async close(node?: Node): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const info = await this.pickForward(
      node,
      (f) => f.estado !== 'fechado',
      l10n.t('Close which port forward?'),
    );
    if (!info) return;
    try {
      await client.request('ssh.forward.close', { id: info.id });
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not close the port forward: {0}', message(error)),
      );
    }
    await this.reload();
  }

  private async forget(node?: Node): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const info = await this.pickForward(node, (f) => f.favorito, l10n.t('Forget which favorite?'));
    if (!info) return;
    await client
      .request('ssh.forward.close', { id: info.id, esquecer: true })
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(message(error));
      });
    await this.reload();
  }

  private async browser(node?: Node): Promise<void> {
    const info = await this.pickForward(
      node,
      (f) => f.estado === 'ativo',
      l10n.t('Open which port forward?'),
    );
    // O endereço vem do Core e é sempre http://127.0.0.1:<porta>.
    if (info) await vscode.env.openExternal(vscode.Uri.parse(info.url));
  }

  /** Item da barra de status: o que fazer com os ativos. */
  private async menu(): Promise<void> {
    const live = this.forwards.filter((f) => f.estado !== 'fechado');
    const picked = await vscode.window.showQuickPick(
      [
        ...live.map((f) => ({
          label: `$(${STATE_ICON[f.estado]}) ${String(f.portaLocal)} -> ${f.host}:${String(f.portaDestino)}`,
          description: stateLabel(f),
          forward: f,
          action: 'browser',
        })),
        {
          label: `$(add) ${l10n.t('New port forward')}`,
          description: '',
          forward: undefined,
          action: 'open',
        },
      ],
      { title: l10n.t('Port forwards') },
    );
    if (!picked) return;
    if (picked.action === 'open') {
      await this.open();
      return;
    }
    if (!picked.forward) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: `$(link-external) ${l10n.t('Open in browser')}`, id: 'browser' },
        { label: `$(close) ${l10n.t('Close the port forward')}`, id: 'close' },
      ],
      { title: picked.forward.id },
    );
    if (action?.id === 'browser') await this.browser(picked.forward);
    if (action?.id === 'close') await this.close(picked.forward);
  }
}
