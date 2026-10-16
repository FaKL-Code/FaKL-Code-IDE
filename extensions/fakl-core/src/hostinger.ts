import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { HostingerStatus } from '@fakl/protocol';
import * as vscode from 'vscode';

const STORED_TOKEN = 'fakl.hostinger.token';
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'ALIAS', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

interface Vps {
  readonly id: number;
  readonly hostname: string;
  readonly estado: string;
  readonly plano?: string;
  readonly ip?: string;
}

interface Domain {
  readonly id: number;
  readonly dominio: string | null;
  readonly estado?: string;
  readonly venceEm?: string | null;
}

interface DnsRecord {
  readonly nome: string;
  readonly tipo: string;
  readonly ttl?: number;
  readonly valores: string[];
}

const FIREWALL_PROTOCOLS = [
  'SSH',
  'HTTP',
  'HTTPS',
  'TCP',
  'UDP',
  'MySQL',
  'PostgreSQL',
  'ICMP',
  'ICMPv6',
  'GRE',
  'ESP',
  'AH',
  'any',
];

interface FirewallRule {
  readonly id: number;
  readonly acao?: string;
  readonly protocolo: string;
  readonly porta?: string;
  readonly origem?: string;
}

interface Firewall {
  readonly id: number;
  readonly nome: string;
  readonly sincronizado?: boolean;
  readonly regras: FirewallRule[];
}

type Node =
  | { readonly t: 'section'; readonly section: 'vps' | 'dominios' | 'firewall' }
  | { readonly t: 'firewall'; readonly firewall: Firewall }
  | { readonly t: 'rule'; readonly firewall: Firewall; readonly rule: FirewallRule }
  | { readonly t: 'vps'; readonly vps: Vps }
  | { readonly t: 'domain'; readonly domain: string; readonly info: Domain }
  | { readonly t: 'record'; readonly domain: string; readonly record: DnsRecord }
  | { readonly t: 'info'; readonly label: string; readonly command?: vscode.Command };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Painel da Hostinger (RF-506): VPS com estado, reinício e snapshot; domínios
 * com vencimento e registros DNS editáveis. O token fica no SecretStorage da
 * IDE e vai ao Core em memória; os VPS entram no gerenciador de SSH (RF-507).
 */
export class HostingerUi implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  private client: CoreClient | undefined;
  private status: HostingerStatus | undefined;
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onVpsSynced: () => void,
  ) {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView('fakl.hostinger', { treeDataProvider: this }),
      context.secrets.onDidChange((event) => {
        if (event.key === STORED_TOKEN) void this.push();
      }),
      vscode.commands.registerCommand('fakl.hostinger.connect', () => this.connect()),
      vscode.commands.registerCommand('fakl.hostinger.disconnect', () => this.disconnect()),
      vscode.commands.registerCommand('fakl.hostinger.refresh', () => this.refresh()),
      vscode.commands.registerCommand('fakl.hostinger.restart', (node: Node) => this.restart(node)),
      vscode.commands.registerCommand('fakl.hostinger.snapshot', (node: Node) =>
        this.snapshot(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.dns.add', (node: Node) =>
        this.editRecord(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.dns.edit', (node: Node) =>
        this.editRecord(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.dns.delete', (node: Node) =>
        this.deleteRecord(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.create', () =>
        this.createFirewall(),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.delete', (node: Node) =>
        this.deleteFirewall(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.attach', (node: Node) =>
        this.attachFirewall(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.rule.add', (node: Node) =>
        this.editRule(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.rule.edit', (node: Node) =>
        this.editRule(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.firewall.rule.delete', (node: Node) =>
        this.deleteRule(node),
      ),
      vscode.commands.registerCommand('fakl.hostinger.panel', () =>
        vscode.env.openExternal(vscode.Uri.parse('https://hpanel.hostinger.com/')),
      ),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.push();
  }

  disconnected(): void {
    this.client = undefined;
    this.status = undefined;
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async push(): Promise<void> {
    if (!this.client) return;
    const token = await this.context.secrets.get(STORED_TOKEN);
    await this.client
      .request('secrets.set', { nome: 'hostinger.token', valor: token ?? null })
      .catch(() => undefined);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.status = await this.client
      ?.request<HostingerStatus>('hostinger.status')
      .catch((error: unknown) => ({ conectado: false, erro: message(error) }));
    this.changed.fire(undefined);
    if (this.status?.conectado) this.onVpsSynced();
  }

  private async connect(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: l10n.t('Hostinger API token'),
      prompt: l10n.t(
        'Generate it in hPanel → Profile → API. It stays in the system keychain, never in a file.',
      ),
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;
    await this.context.secrets.store(STORED_TOKEN, token.trim());
    await this.push();
    if (this.status?.conectado) {
      void vscode.window.showInformationMessage(
        l10n.t('Hostinger connected; your VPSs were added to SSH.'),
      );
    } else {
      void vscode.window.showErrorMessage(
        l10n.t('Hostinger rejected the token: {0}', this.status?.erro ?? l10n.t('unknown error')),
      );
    }
  }

  private async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORED_TOKEN);
    await this.push();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const client = this.client;
    if (!client) return [{ t: 'info', label: l10n.t('The FaKL Core is not responding.') }];
    try {
      if (!node) {
        if (!this.status?.conectado) {
          return [
            {
              t: 'info',
              label: this.status?.erro
                ? l10n.t('Error: {0}', this.status.erro)
                : l10n.t('Connect to Hostinger'),
              command: { command: 'fakl.hostinger.connect', title: l10n.t('Connect') },
            },
          ];
        }
        return [
          { t: 'section', section: 'vps' },
          { t: 'section', section: 'dominios' },
          { t: 'section', section: 'firewall' },
        ];
      }
      if (node.t === 'section' && node.section === 'vps') {
        const list = await client.request<Vps[]>('hostinger.vps.list');
        return list.length === 0
          ? [{ t: 'info', label: l10n.t('No VPS.') }]
          : list.map((vps) => ({ t: 'vps', vps }));
      }
      if (node.t === 'section' && node.section === 'firewall') {
        const list = await client.request<Firewall[]>('hostinger.firewall.list');
        return list.length === 0
          ? [{ t: 'info', label: l10n.t('No firewalls.') }]
          : list.map((firewall) => ({ t: 'firewall', firewall }));
      }
      if (node.t === 'firewall') {
        return node.firewall.regras.length === 0
          ? [{ t: 'info', label: l10n.t('No rules: nothing is allowed.') }]
          : node.firewall.regras.map((rule) => ({ t: 'rule', firewall: node.firewall, rule }));
      }
      if (node.t === 'section') {
        const list = await client.request<Domain[]>('hostinger.domains.list');
        return list.flatMap((info): Node[] =>
          info.dominio ? [{ t: 'domain', domain: info.dominio, info }] : [],
        );
      }
      if (node.t === 'domain') {
        const records = await client.request<DnsRecord[]>('hostinger.dns.list', {
          dominio: node.domain,
        });
        return records.map((record) => ({ t: 'record', domain: node.domain, record }));
      }
    } catch (error) {
      return [{ t: 'info', label: l10n.t('Error: {0}', message(error)) }];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.t) {
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        if (node.command) item.command = node.command;
        return item;
      }
      case 'section': {
        const titles = { vps: 'VPS', dominios: l10n.t('Domains'), firewall: 'Firewall' };
        const icons = { vps: 'server-environment', dominios: 'globe', firewall: 'shield' };
        const item = new vscode.TreeItem(
          titles[node.section],
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(icons[node.section]);
        if (node.section === 'firewall') item.contextValue = 'firewall-section';
        return item;
      }
      case 'firewall': {
        const { firewall } = node;
        const item = new vscode.TreeItem(firewall.nome, vscode.TreeItemCollapsibleState.Collapsed);
        const rules =
          firewall.regras.length === 1
            ? l10n.t('1 rule')
            : l10n.t('{0} rules', String(firewall.regras.length));
        item.description =
          firewall.sincronizado === false ? l10n.t('{0} · out of sync', rules) : rules;
        item.iconPath = new vscode.ThemeIcon('shield');
        item.contextValue = 'firewall';
        return item;
      }
      case 'rule': {
        const { rule } = node;
        const item = new vscode.TreeItem(`${rule.protocolo} ${rule.porta ?? ''}`.trim());
        item.description = `${rule.acao === 'drop' ? l10n.t('blocks') : l10n.t('allows')} · ${rule.origem && rule.origem !== 'any' ? rule.origem : l10n.t('any source')}`;
        item.contextValue = 'firewall-rule';
        return item;
      }
      case 'vps': {
        const { vps } = node;
        const item = new vscode.TreeItem(vps.hostname);
        item.description = `${vps.estado}${vps.ip ? ` · ${vps.ip}` : ''}${vps.plano ? ` · ${vps.plano}` : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          vps.estado === 'running' ? 'vm-running' : vps.estado === 'stopped' ? 'vm-outline' : 'vm',
        );
        item.contextValue = 'vps';
        return item;
      }
      case 'domain': {
        const item = new vscode.TreeItem(node.domain, vscode.TreeItemCollapsibleState.Collapsed);
        const expires = node.info.venceEm ? new Date(node.info.venceEm) : undefined;
        const soon = expires && expires.getTime() - Date.now() < 30 * 86_400_000;
        item.description = `${node.info.estado ?? ''}${expires ? ` · ${l10n.t('expires {0}', expires.toLocaleDateString())}` : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          soon ? 'warning' : 'globe',
          soon ? new vscode.ThemeColor('list.warningForeground') : undefined,
        );
        item.contextValue = 'domain';
        return item;
      }
      case 'record': {
        const { record } = node;
        const item = new vscode.TreeItem(`${record.tipo} ${record.nome}`);
        item.description = record.valores.join(', ');
        item.tooltip = `TTL ${String(record.ttl ?? '?')}\n${record.valores.join('\n')}`;
        item.contextValue = 'dns-record';
        return item;
      }
    }
  }

  private async restart(node: Node): Promise<void> {
    if (node.t !== 'vps' || !this.client) return;
    const ok = await vscode.window.showWarningMessage(
      l10n.t('Restart {0}? The server will be down for a few minutes.', node.vps.hostname),
      { modal: true },
      l10n.t('Restart'),
    );
    if (!ok) return;
    await this.run(
      () => this.client?.request('hostinger.vps.restart', { vpsId: node.vps.id }),
      l10n.t('Restart requested.'),
    );
  }

  private async snapshot(node: Node): Promise<void> {
    if (node.t !== 'vps' || !this.client) return;
    const client = this.client;
    const current = await client
      .request<{ created_at?: string } | null>('hostinger.vps.snapshot', { vpsId: node.vps.id })
      .catch(() => null);
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: `$(save) ${l10n.t('Create snapshot')}`,
          detail: l10n.t('Replaces the current snapshot'),
          acao: 'criar',
        },
        {
          label: `$(history) ${l10n.t('Restore snapshot')}`,
          detail: current?.created_at
            ? l10n.t('Brings the server back to {0}', new Date(current.created_at).toLocaleString())
            : l10n.t('No snapshot found'),
          acao: 'restaurar',
        },
      ],
      {
        title: l10n.t('Snapshot of {0}', node.vps.hostname),
        placeHolder: current?.created_at
          ? l10n.t('Current: {0}', new Date(current.created_at).toLocaleString())
          : l10n.t('No snapshot'),
      },
    );
    if (!picked) return;
    if (picked.acao === 'restaurar') {
      const ok = await vscode.window.showWarningMessage(
        l10n.t(
          'Restore {0}? Everything that changed after the snapshot will be lost.',
          node.vps.hostname,
        ),
        { modal: true },
        l10n.t('Restore'),
      );
      if (!ok) return;
    }
    await this.run(
      () => client.request('hostinger.vps.snapshot', { vpsId: node.vps.id, acao: picked.acao }),
      picked.acao === 'criar' ? l10n.t('Snapshot requested.') : l10n.t('Restore requested.'),
    );
  }

  private async editRecord(node: Node): Promise<void> {
    const domain = node.t === 'domain' || node.t === 'record' ? node.domain : undefined;
    if (!domain || !this.client) return;
    const existing = node.t === 'record' ? node.record : undefined;
    const tipo =
      existing?.tipo ??
      (await vscode.window.showQuickPick(DNS_TYPES, {
        title: l10n.t('New record on {0}', domain),
      }));
    if (!tipo) return;
    const nome =
      existing?.nome ??
      (await vscode.window.showInputBox({
        title: l10n.t('{0} on {1}: name', tipo, domain),
        prompt: l10n.t('@ for the root, or a subdomain like www'),
        value: '@',
      }));
    if (!nome) return;
    const valores = await vscode.window.showInputBox({
      title: l10n.t('{0} {1}.{2}: value', tipo, nome, domain),
      prompt: l10n.t('Several comma-separated values replace all current ones'),
      value: existing?.valores.join(', ') ?? '',
    });
    if (!valores) return;
    const ttl = await vscode.window.showInputBox({
      title: l10n.t('TTL (seconds)'),
      value: String(existing?.ttl ?? 3600),
      validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 60 ? undefined : l10n.t('Minimum 60')),
    });
    if (!ttl) return;
    await this.run(
      () =>
        this.client?.request('hostinger.dns.upsert', {
          dominio: domain,
          registros: [
            {
              nome,
              tipo,
              ttl: Number(ttl),
              valores: valores
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            },
          ],
        }),
      l10n.t('{0} {1} saved on {2}.', tipo, nome, domain),
    );
  }

  private async deleteRecord(node: Node): Promise<void> {
    if (node.t !== 'record' || !this.client) return;
    const ok = await vscode.window.showWarningMessage(
      l10n.t('Delete {0} {1} from {2}?', node.record.tipo, node.record.nome, node.domain),
      { modal: true },
      l10n.t('Delete'),
    );
    if (!ok) return;
    await this.run(
      () =>
        this.client?.request('hostinger.dns.delete', {
          dominio: node.domain,
          nome: node.record.nome,
          tipo: node.record.tipo,
        }),
      l10n.t('Record deleted.'),
    );
  }

  private async createFirewall(): Promise<void> {
    if (!this.client) return;
    const nome = await vscode.window.showInputBox({ title: l10n.t('Name of the new firewall') });
    if (!nome) return;
    await this.run(
      () => this.client?.request('hostinger.firewall.create', { nome }),
      l10n.t('Firewall {0} created.', nome),
    );
  }

  private async deleteFirewall(node: Node): Promise<void> {
    if (node.t !== 'firewall' || !this.client) return;
    const ok = await vscode.window.showWarningMessage(
      l10n.t(
        'Delete firewall {0}? The VPSs attached to it will be left unprotected.',
        node.firewall.nome,
      ),
      { modal: true },
      l10n.t('Delete'),
    );
    if (!ok) return;
    await this.run(
      () => this.client?.request('hostinger.firewall.delete', { firewallId: node.firewall.id }),
      l10n.t('Firewall deleted.'),
    );
  }

  private async attachFirewall(node: Node): Promise<void> {
    if (node.t !== 'firewall' || !this.client) return;
    const client = this.client;
    const list = await client.request<Vps[]>('hostinger.vps.list').catch((): Vps[] => []);
    const vps = await vscode.window.showQuickPick(
      list.map((v) => ({ label: v.hostname, description: v.ip ?? '', id: v.id })),
      { title: l10n.t('Firewall {0}: choose the VPS', node.firewall.nome) },
    );
    if (!vps) return;
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: `$(plug) ${l10n.t('Attach')}`,
          detail: l10n.t('Replaces the VPS’s current firewall with this one'),
          acao: 'ligar',
        },
        {
          label: `$(sync) ${l10n.t('Sync')}`,
          detail: l10n.t('Reapplies the rules on the VPS'),
          acao: 'sincronizar',
        },
        {
          label: `$(debug-disconnect) ${l10n.t('Detach')}`,
          detail: l10n.t('The VPS is left without this firewall'),
          acao: 'desligar',
        },
      ],
      { title: l10n.t('{0} on {1}', node.firewall.nome, vps.label) },
    );
    if (!picked) return;
    await this.run(
      () =>
        client.request('hostinger.firewall.attach', {
          firewallId: node.firewall.id,
          vpsId: vps.id,
          acao: picked.acao,
        }),
      l10n.t('Request sent to Hostinger.'),
    );
  }

  private async editRule(node: Node): Promise<void> {
    if ((node.t !== 'firewall' && node.t !== 'rule') || !this.client) return;
    const { firewall } = node;
    const existing = node.t === 'rule' ? node.rule : undefined;
    const protocolo =
      existing?.protocolo ??
      (await vscode.window.showQuickPick(FIREWALL_PROTOCOLS, {
        title: l10n.t('New rule on {0}: protocol', firewall.nome),
      }));
    if (!protocolo) return;
    const porta = await vscode.window.showInputBox({
      title: l10n.t('{0}: port', protocolo),
      prompt: l10n.t('A number (22), a range (8000:8100) or any'),
      value: existing?.porta ?? '',
      validateInput: (v) =>
        /^(any|\d{1,5}(:\d{1,5})?)$/.test(v) ? undefined : l10n.t('Number, range or any'),
    });
    if (!porta) return;
    const origem = await vscode.window.showInputBox({
      title: l10n.t('{0} {1}: source', protocolo, porta),
      prompt: l10n.t('any for any source, or an IP / CIDR (203.0.113.0/24)'),
      value: existing?.origem ?? 'any',
    });
    if (!origem) return;
    await this.run(
      () =>
        this.client?.request('hostinger.firewall.rule.upsert', {
          firewallId: firewall.id,
          ...(existing ? { regraId: existing.id } : {}),
          protocolo,
          porta,
          origem,
        }),
      l10n.t('Rule {0} {1} saved. Sync with the VPS to apply it.', protocolo, porta),
    );
  }

  private async deleteRule(node: Node): Promise<void> {
    if (node.t !== 'rule' || !this.client) return;
    const ok = await vscode.window.showWarningMessage(
      l10n.t(
        'Delete rule {0} {1} from {2}?',
        node.rule.protocolo,
        node.rule.porta ?? '',
        node.firewall.nome,
      ),
      { modal: true },
      l10n.t('Delete'),
    );
    if (!ok) return;
    await this.run(
      () =>
        this.client?.request('hostinger.firewall.rule.delete', {
          firewallId: node.firewall.id,
          regraId: node.rule.id,
        }),
      l10n.t('Rule deleted. Sync with the VPS to apply it.'),
    );
  }

  private async run(action: () => Promise<unknown> | undefined, done: string): Promise<void> {
    try {
      await action();
      void vscode.window.showInformationMessage(done);
      this.changed.fire(undefined);
    } catch (error) {
      void vscode.window.showErrorMessage(message(error));
    }
  }
}
