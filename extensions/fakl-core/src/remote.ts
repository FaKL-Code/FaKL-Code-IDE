import { randomBytes } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { currentLocale, l10n } from '@fakl/i18n';
import type {
  RemoteDeviceEventData,
  RemoteDeviceInfo,
  RemotePairingInfo,
  RemoteScopeName,
  RemoteStatus,
  RemoteTestParams,
  RemoteTestResult,
} from '@fakl/protocol';
import QRCode from 'qrcode';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';

/** Chave da identidade do controle remoto no SecretStorage da IDE (ADR 0044). */
const STORED_IDENTITY_KEY = 'fakl.remote.identidade';

function scopeOptions(): { scope: RemoteScopeName; label: string; detail: string }[] {
  return [
    { scope: 'ver', label: l10n.t('View'), detail: l10n.t('Agents, runs, diffs, logs and costs') },
    {
      scope: 'decidir',
      label: l10n.t('Decide'),
      detail: l10n.t('Answer decisions and permission requests'),
    },
    {
      scope: 'comandar',
      label: l10n.t('Command'),
      detail: l10n.t('Create tasks, pause, resume and stop agents'),
    },
    {
      scope: 'editor',
      label: l10n.t('Editor'),
      detail: l10n.t('Open the full IDE in the browser (optional)'),
    },
  ];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Texto do resultado de `remote.test` para um aviso da IDE. */
function describeTest(result: RemoteTestResult): string {
  if (!result.ok) return l10n.t('Relay has a problem: {0}', result.mensagem);
  const parts = [
    `${result.mensagem}${result.latenciaMs !== undefined ? ` (${String(result.latenciaMs)} ms)` : ''}`,
  ];
  if (result.push === false) parts.push(l10n.t('No VAPID keys: push notifications will not work.'));
  if (result.aviso) parts.push(result.aviso);
  return parts.join(' ');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/**
 * Controles do acesso remoto na IDE (SDD 12.5, RF-301 e RF-305): ícone na
 * barra de status, liga e desliga, QR code do pareamento, confirmação do
 * aparelho e lista de aparelhos com revogação.
 */
export class RemoteUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly item: vscode.StatusBarItem;
  private client: CoreClient | undefined;
  private status: RemoteStatus | undefined;
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    router: AgentEventRouter,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'fakl.remote',
      vscode.StatusBarAlignment.Left,
      98,
    );
    this.item.name = l10n.t('FaKL remote access');
    this.item.command = 'fakl.remote.menu';
    this.disposables.push(
      this.item,
      context.secrets.onDidChange((event) => {
        if (event.key === STORED_IDENTITY_KEY) void this.pushIdentityKey();
      }),
      router.listen((event) => {
        if (event.topic === 'remote.status') {
          this.status = event.data as RemoteStatus;
          this.render();
        } else if (event.topic === 'remote.device') {
          void this.onDevice(event.data as RemoteDeviceEventData);
        } else if (event.topic === 'config.changed') {
          void this.reload();
        }
      }),
      vscode.commands.registerCommand('fakl.remote.menu', () => this.menu()),
      vscode.commands.registerCommand('fakl.remote.toggle', () => this.toggle()),
      vscode.commands.registerCommand('fakl.remote.pair', () => this.pair()),
      vscode.commands.registerCommand('fakl.remote.devices', () => this.devices()),
      vscode.commands.registerCommand('fakl.remote.configure', () => this.configure()),
      vscode.commands.registerCommand('fakl.remote.test', () => this.test()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.pushIdentityKey();
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
    this.status = undefined;
    this.render();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /**
   * Entrega ao Core a chave que cifra a identidade do controle remoto (ADR
   * 0044). Ela é gerada aqui na primeira vez e fica só no SecretStorage da IDE,
   * cifrado pelo cofre do sistema; o Core a recebe em memória a cada conexão.
   */
  private async pushIdentityKey(): Promise<void> {
    const client = this.client;
    if (!client) return;
    let key = await this.context.secrets.get(STORED_IDENTITY_KEY);
    if (!key) {
      key = randomBytes(32).toString('base64url');
      await this.context.secrets.store(STORED_IDENTITY_KEY, key);
    }
    await client.request('secrets.set', { nome: 'remote.identidade', valor: key }).catch(() => {
      // Core antigo ou fechado: o gateway segue como antes, com aviso no log.
    });
  }

  private async reload(): Promise<void> {
    if (!this.client) return;
    this.status = await this.client.request<RemoteStatus>('remote.status').catch(() => undefined);
    this.render();
  }

  private render(): void {
    const status = this.status;
    if (!this.client || !status) {
      this.item.hide();
      return;
    }
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${l10n.t('Remote access')}**\n\n`);
    switch (status.estado) {
      case 'ligado':
        this.item.text =
          status.conectados > 0 ? `$(radio-tower) ${String(status.conectados)}` : '$(radio-tower)';
        tooltip.appendMarkdown(
          `${
            status.conectados === 0
              ? l10n.t('On, no devices connected')
              : status.conectados === 1
                ? l10n.t('On, 1 device connected')
                : l10n.t('On, {0} devices connected', String(status.conectados))
          }\n\n`,
        );
        break;
      case 'conectando':
        this.item.text = `$(sync~spin) ${l10n.t('Remote')}`;
        tooltip.appendMarkdown(`${l10n.t('Connecting to the relay…')}\n\n`);
        break;
      case 'erro':
        this.item.text = `$(warning) ${l10n.t('Remote')}`;
        tooltip.appendMarkdown(`${status.erro ?? l10n.t('Error')}\n\n`);
        break;
      default:
        this.item.text = `$(circle-slash) ${l10n.t('Remote')}`;
        tooltip.appendMarkdown(`${l10n.t('Off')}\n\n`);
    }
    if (status.relay) tooltip.appendMarkdown(`Relay: ${status.relay}\n\n`);
    tooltip.appendMarkdown(
      status.aparelhos === 1
        ? l10n.t('1 paired device')
        : l10n.t('{0} paired devices', String(status.aparelhos)),
    );
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      status.estado === 'erro'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.item.show();
  }

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  private async menu(): Promise<void> {
    const on = this.status?.ligado ?? false;
    const items: (vscode.QuickPickItem & { command: string })[] = [
      {
        label: on
          ? `$(circle-slash) ${l10n.t('Turn off remote access')}`
          : `$(radio-tower) ${l10n.t('Turn on remote access')}`,
        command: 'fakl.remote.toggle',
      },
      { label: `$(device-mobile) ${l10n.t('Pair device')}`, command: 'fakl.remote.pair' },
      {
        label: `$(list-unordered) ${l10n.t('Paired devices')}`,
        description: String(this.status?.aparelhos ?? 0),
        command: 'fakl.remote.devices',
      },
      {
        label: `$(gear) ${l10n.t('Set up relay')}`,
        description: this.status?.relay ?? '',
        command: 'fakl.remote.configure',
      },
      { label: `$(pulse) ${l10n.t('Test connection to the relay')}`, command: 'fakl.remote.test' },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: l10n.t('Remote access') });
    if (picked) await vscode.commands.executeCommand(picked.command);
  }

  /** Liga; sem relay configurado, pergunta o endereço antes. */
  private async enable(): Promise<boolean> {
    const client = this.requireClient();
    if (!client) return false;
    if (!this.status?.relay) return this.configure();
    try {
      this.status = await client.request<RemoteStatus>('remote.enable');
      this.render();
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not turn on remote access: {0}', message(error)),
      );
      return false;
    }
  }

  private async toggle(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    if (this.status?.ligado) {
      this.status = await client.request<RemoteStatus>('remote.disable');
      this.render();
    } else {
      await this.enable();
    }
  }

  private async configure(): Promise<boolean> {
    const client = this.requireClient();
    if (!client) return false;
    const relay = await vscode.window.showInputBox({
      title: l10n.t('Remote access relay'),
      prompt: l10n.t('HTTPS address of the relay on your VPS (see packages/relay/README.md)'),
      placeHolder: l10n.t('https://relay.example.com'),
      value: this.status?.relay ?? '',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' || url.hostname === 'localhost'
            ? undefined
            : l10n.t('Use https: the phone requires a secure connection');
        } catch {
          return l10n.t('Invalid address');
        }
      },
    });
    if (!relay) return false;
    const chave = await vscode.window.showInputBox({
      title: l10n.t('Relay key'),
      prompt: l10n.t(
        "The FAKL_RELAY_KEY value on the relay (leave empty if it doesn't require one)",
      ),
      password: true,
      ignoreFocusOut: true,
    });
    if (chave === undefined) return false;
    const result = await this.runTest(client, { relay, ...(chave ? { chave } : {}) });
    if (result && !result.ok) {
      const saveAnyway = l10n.t('Save anyway');
      const choice = await vscode.window.showWarningMessage(
        describeTest(result),
        { modal: true },
        saveAnyway,
      );
      if (choice !== saveAnyway) return false;
    } else if (result?.aviso) {
      void vscode.window.showWarningMessage(describeTest(result));
    }
    const yes = l10n.t('Yes');
    const auto = await vscode.window.showQuickPick([l10n.t('No'), yes], {
      title: l10n.t('Turn on remote access whenever the IDE opens?'),
    });
    try {
      this.status = await client.request<RemoteStatus>('remote.enable', {
        relay,
        ...(chave ? { chave } : {}),
        ligarAoAbrir: auto === yes,
      });
      this.render();
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not set up the relay: {0}', message(error)),
      );
      return false;
    }
  }

  /** Testa o relay do config.yaml (HTTPS, WebSocket e chave) e mostra o resultado. */
  private async test(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    if (!this.status?.relay) {
      const choice = await vscode.window.showWarningMessage(
        l10n.t('No relay set up yet.'),
        l10n.t('Set up relay'),
      );
      if (choice) await this.configure();
      return;
    }
    const result = await this.runTest(client, {});
    if (!result) return;
    if (result.ok) {
      const show = result.aviso
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
      void show(describeTest(result));
      return;
    }
    const choice = await vscode.window.showErrorMessage(
      describeTest(result),
      l10n.t('Set up relay'),
    );
    if (choice) await this.configure();
  }

  private async runTest(
    client: CoreClient,
    params: RemoteTestParams,
  ): Promise<RemoteTestResult | undefined> {
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n.t('Testing the relay…') },
        () => client.request<RemoteTestResult>('remote.test', params),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not test the relay: {0}', message(error)));
      return undefined;
    }
  }

  private async pair(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    if (!this.status?.relay && !(await this.configure())) return;
    let info: RemotePairingInfo;
    try {
      info = await client.request<RemotePairingInfo>('remote.pair.begin');
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not pair: {0}', message(error)));
      return;
    }
    const svg = await QRCode.toString(info.url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
    });
    this.panel?.dispose();
    const panel = vscode.window.createWebviewPanel(
      'fakl.remote.pair',
      l10n.t('Pair device'),
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: false },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        void this.client?.request('remote.pair.cancel').catch(() => undefined);
      }
    });
    const expires = new Date(info.expiraEm).toLocaleTimeString(currentLocale(), {
      hour: '2-digit',
      minute: '2-digit',
    });
    panel.webview.html = `<!doctype html>
<html lang="${vscode.env.language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; padding: 24px; gap: 12px; text-align: center; }
  .qr { background: #fff; padding: 12px; border-radius: 12px; width: min(320px, 80vw); }
  .qr svg { width: 100%; height: auto; display: block; }
  .impressao { font-family: var(--vscode-editor-font-family); font-size: 1.4em; letter-spacing: 1px; }
  .meta { color: var(--vscode-descriptionForeground); max-width: 480px; }
  code { word-break: break-all; font-size: 0.85em; }
</style></head><body>
<h2>${escapeHtml(l10n.t('Scan with your phone’s camera'))}</h2>
<div class="qr" role="img" aria-label="${escapeHtml(l10n.t('Pairing QR code'))}">${svg}</div>
<p>${l10n.t('This IDE’s fingerprint: {0}', `<span class="impressao">${escapeHtml(info.impressao)}</span>`)}</p>
<p class="meta">${escapeHtml(
      l10n.t(
        'The phone shows the same fingerprint. The code works once, until {0}. When the device asks, the IDE asks you to confirm.',
        expires,
      ),
    )}</p>
</body></html>`;
  }

  private async onDevice(data: RemoteDeviceEventData): Promise<void> {
    if (data.tipo === 'pedido') {
      const client = this.client;
      if (!client) return;
      const pairWithEditor = l10n.t('Pair and allow editor');
      const choice = await vscode.window.showInformationMessage(
        l10n.t('Pair "{0}" with this IDE?', data.nome),
        {
          modal: true,
          detail: l10n.t(
            "Device fingerprint: {0}. It will be able to see agents and runs, answer decisions and command agents. Decline if you weren't the one who just scanned the QR code.",
            data.impressao,
          ),
        },
        l10n.t('Pair'),
        pairWithEditor,
      );
      const escopos: RemoteScopeName[] =
        choice === pairWithEditor
          ? ['ver', 'decidir', 'comandar', 'editor']
          : ['ver', 'decidir', 'comandar'];
      await client
        .request('remote.pair.confirm', {
          pairingId: data.pairingId,
          aceitar: choice !== undefined,
          escopos,
        })
        .catch((error: unknown) => {
          void vscode.window.showWarningMessage(
            l10n.t('Pairing was not completed: {0}', message(error)),
          );
        });
      return;
    }
    if (data.tipo === 'pareado') {
      this.panel?.dispose();
      void vscode.window.showInformationMessage(l10n.t('"{0}" paired.', data.aparelho.nome));
    } else if (data.tipo === 'conectado') {
      vscode.window.setStatusBarMessage(
        `$(device-mobile) ${l10n.t('{0} connected', data.aparelho.nome)}`,
        4_000,
      );
    }
    await this.reload();
  }

  private async devices(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const devices = await client.request<RemoteDeviceInfo[]>('remote.devices.list');
    if (devices.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        l10n.t('No paired devices.'),
        l10n.t('Pair device'),
      );
      if (choice) await this.pair();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      devices.map((device) => ({
        label: `${device.conectado ? '$(circle-filled)' : '$(circle-outline)'} ${device.nome}`,
        description: device.escopos
          .map((scope) => scopeOptions().find((s) => s.scope === scope)?.label ?? scope)
          .join(', '),
        detail: [
          l10n.t('paired on {0}', new Date(device.criadoEm).toLocaleDateString(currentLocale())),
          device.ultimoAcesso
            ? l10n.t(
                'last access {0}',
                new Date(device.ultimoAcesso).toLocaleString(currentLocale()),
              )
            : l10n.t('never accessed'),
          device.push ? l10n.t('gets notifications') : '',
        ]
          .filter(Boolean)
          .join(' · '),
        device,
      })),
      { title: l10n.t('Paired devices') },
    );
    if (!picked) return;
    const device = picked.device;
    const action = await vscode.window.showQuickPick(
      [
        { label: `$(edit) ${l10n.t('Change permissions')}`, revoke: false },
        { label: `$(trash) ${l10n.t('Revoke')}`, revoke: true },
      ],
      {
        title: device.nome,
      },
    );
    if (action?.revoke) {
      const sure = await vscode.window.showWarningMessage(
        l10n.t('Revoke "{0}"? It loses access right away and must pair again.', device.nome),
        { modal: true },
        l10n.t('Revoke'),
      );
      if (!sure) return;
      await client.request('remote.devices.revoke', { id: device.id });
      void vscode.window.showInformationMessage(l10n.t('"{0}" revoked.', device.nome));
    } else if (action) {
      const scopes = await vscode.window.showQuickPick(
        scopeOptions().map((s) => ({ ...s, picked: device.escopos.includes(s.scope) })),
        { title: l10n.t('Permissions for {0}', device.nome), canPickMany: true },
      );
      if (!scopes) return;
      await client.request('remote.devices.update', {
        id: device.id,
        escopos: scopes.map((s) => s.scope),
      });
    }
    await this.reload();
  }
}
