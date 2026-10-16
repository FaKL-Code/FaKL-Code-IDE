import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { SshExecResult, SshHostInfo, SshPolicyName } from '@fakl/protocol';
import * as vscode from 'vscode';

import { SSH_SCHEME, SshFileSystem } from './ssh-fs.js';
import { multiplexArgs, quote } from './ssh-shell.js';
import {
  addRemoteFolder,
  normalizeRemotePath,
  remoteFolders,
  remoteName,
  removeRemoteFolder,
  rootKey,
} from './ssh-workspace.js';

type Node =
  | { readonly t: 'group'; readonly name: string; readonly hosts: SshHostInfo[] }
  | { readonly t: 'host'; readonly host: SshHostInfo }
  | { readonly t: 'info'; readonly label: string };

function policies(): { value: SshPolicyName; label: string; detail: string }[] {
  return [
    {
      value: 'confirmar',
      label: l10n.t('Confirm (default)'),
      detail: l10n.t('Every agent command asks for your approval'),
    },
    {
      value: 'leitura',
      label: l10n.t('Read only'),
      detail: l10n.t('Read commands run directly; everything else asks for approval'),
    },
    {
      value: 'livre',
      label: l10n.t('Free'),
      detail: l10n.t('Runs and goes to the audit log; destructive commands still ask for approval'),
    },
    { value: 'bloqueado', label: l10n.t('Blocked'), detail: l10n.t('Agents cannot use this host') },
  ];
}

/** Nome curto da política, para a descrição e a dica do host. */
function policyName(policy: SshPolicyName): string {
  switch (policy) {
    case 'confirmar':
      return l10n.t('confirm');
    case 'leitura':
      return l10n.t('read only');
    case 'livre':
      return l10n.t('free');
    case 'bloqueado':
      return l10n.t('blocked');
  }
}

const POLICY_ICON: Record<SshPolicyName, string> = {
  livre: 'unlock',
  confirmar: 'shield',
  leitura: 'eye',
  bloqueado: 'lock',
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Gerenciador de SSH na IDE (RF-503 a RF-505): hosts do ~/.ssh/config, da
 * IDE e da Hostinger, agrupados; política por host para agentes; terminal,
 * comando avulso e pasta remota nativa (`fakl-ssh://`, em `ssh-fs.ts`).
 */
export class SshUi implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly output = vscode.window.createOutputChannel('FaKL SSH');
  private client: CoreClient | undefined;
  private hosts: SshHostInfo[] = [];
  private loaded: Promise<void> | undefined;
  private markLoaded: (() => void) | undefined;
  private readonly fs = new SshFileSystem((alias) => this.targetFor(alias));
  /** Um terminal por raiz remota (ou por host, sem raiz), para focar em vez de duplicar. */
  private readonly terminals = new Map<string, vscode.Terminal>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    this.loaded = new Promise((resolve) => {
      this.markLoaded = resolve;
    });
    this.disposables.push(
      this.fs,
      vscode.workspace.registerFileSystemProvider(SSH_SCHEME, this.fs, { isCaseSensitive: true }),
      this.changed,
      this.output,
      vscode.window.createTreeView('fakl.ssh.hosts', { treeDataProvider: this }),
      vscode.commands.registerCommand('fakl.ssh.refresh', () => this.reload()),
      vscode.commands.registerCommand('fakl.ssh.add', () => this.add()),
      vscode.commands.registerCommand('fakl.ssh.terminal', (node?: Node) => this.terminal(node)),
      vscode.commands.registerCommand('fakl.ssh.addToWorkspace', (node?: Node) =>
        this.addToWorkspace(node, 'ask'),
      ),
      vscode.commands.registerCommand('fakl.ssh.openFolder', (node?: Node) =>
        this.addToWorkspace(node, 'new-window'),
      ),
      vscode.commands.registerCommand('fakl.ssh.removeFromWorkspace', (arg?: Node | vscode.Uri) =>
        this.removeFromWorkspace(arg),
      ),
      vscode.commands.registerCommand('fakl.ssh.folderTerminal', (arg?: Node | vscode.Uri) =>
        this.folderTerminal(arg),
      ),
      vscode.window.registerTerminalProfileProvider('fakl.ssh.terminal', {
        provideTerminalProfile: () => this.terminalProfile(),
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        this.foldersChanged(event);
      }),
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [key, terminal] of this.terminals) {
          if (terminal === closed) this.terminals.delete(key);
        }
      }),
      vscode.commands.registerCommand('fakl.ssh.exec', (node?: Node) => this.exec(node)),
      vscode.commands.registerCommand('fakl.ssh.policy', (node?: Node) => this.policy(node)),
      vscode.commands.registerCommand('fakl.ssh.tags', (node?: Node) => this.tags(node)),
      vscode.commands.registerCommand('fakl.ssh.remove', (node?: Node) => this.remove(node)),
      vscode.commands.registerCommand('fakl.ssh.editConfig', () =>
        vscode.window.showTextDocument(vscode.Uri.file(join(homedir(), '.ssh', 'config'))),
      ),
      vscode.commands.registerCommand('fakl.ssh.keygen', () => {
        this.keygen();
      }),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload().finally(() => this.markLoaded?.());
  }

  /**
   * Argumentos do ssh para um alias de `fakl-ssh://`. Numa janela que abre já
   * na pasta remota, espera um pouco a lista de hosts do Core; sem ela, usa o
   * alias direto (que vale para hosts do ~/.ssh/config).
   */
  private async targetFor(alias: string): Promise<string[]> {
    if (!this.hosts.some((h) => h.alias === alias)) {
      await Promise.race([this.loaded, new Promise((r) => setTimeout(r, 8_000))]);
    }
    const host = this.hosts.find((h) => h.alias === alias);
    return host ? this.target(host) : [alias];
  }

  /** Raízes remotas (`fakl-ssh://`) do workspace atual. */
  private roots(alias?: string): { alias: string; path: string }[] {
    return remoteFolders(vscode.workspace.workspaceFolders)
      .filter((r) => alias === undefined || r.alias === alias)
      .map(({ alias: a, path }) => ({ alias: a, path }));
  }

  /** Terminal SSH já na pasta da raiz: foca o que existe, ou cria um (um por raiz). */
  private async rootTerminal(alias: string, path: string): Promise<void> {
    const key = rootKey(alias, path);
    const existing = this.terminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const options = await this.rootTerminalOptions(alias, path);
    const terminal = vscode.window.createTerminal(options);
    this.terminals.set(key, terminal);
    terminal.show();
  }

  private async rootTerminalOptions(alias: string, path: string): Promise<vscode.TerminalOptions> {
    const target = await this.targetFor(alias);
    return {
      name: `SSH ${remoteName(alias, path)}`,
      shellPath: 'ssh',
      shellArgs: [
        '-t',
        ...multiplexArgs(),
        ...target,
        `cd ${quote(normalizeRemotePath(path))} && exec "$SHELL" -l`,
      ],
      iconPath: new vscode.ThemeIcon('remote'),
    };
  }

  /** Escolhe uma raiz remota entre as do workspace (sem perguntar se só há uma). */
  private async pickRoot(
    candidates: { alias: string; path: string }[],
    title: string,
  ): Promise<{ alias: string; path: string } | undefined> {
    if (candidates.length <= 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((root) => ({ label: remoteName(root.alias, root.path), root })),
      { title },
    );
    return picked?.root;
  }

  /** Raiz de um argumento de comando: nó da árvore ou recurso do explorador. */
  private async rootFor(
    arg: Node | vscode.Uri | undefined,
    title: string,
  ): Promise<{ alias: string; path: string } | undefined> {
    if (arg instanceof vscode.Uri) {
      if (arg.scheme !== SSH_SCHEME) return undefined;
      const folder = vscode.workspace.getWorkspaceFolder(arg)?.uri ?? arg;
      return { alias: folder.authority, path: normalizeRemotePath(folder.path) };
    }
    if (arg?.t === 'host') return this.pickRoot(this.roots(arg.host.alias), title);
    return this.pickRoot(this.roots(), title);
  }

  private async folderTerminal(arg?: Node | vscode.Uri): Promise<void> {
    const root = await this.rootFor(arg, l10n.t('Terminal in which remote folder?'));
    if (root) {
      await this.rootTerminal(root.alias, root.path);
      return;
    }
    // Sem pasta remota no workspace, vale o terminal do host.
    await this.terminal(arg instanceof vscode.Uri ? undefined : arg, true);
  }

  /** Perfil de terminal "SSH (FaKL)": na pasta remota do workspace, ou no host escolhido. */
  private async terminalProfile(): Promise<vscode.TerminalProfile | undefined> {
    const root = await this.pickRoot(this.roots(), l10n.t('Terminal in which remote folder?'));
    if (root)
      return new vscode.TerminalProfile(await this.rootTerminalOptions(root.alias, root.path));
    const host = await this.pickHost();
    if (!host) return undefined;
    return new vscode.TerminalProfile({
      name: `SSH ${host.alias}`,
      shellPath: 'ssh',
      shellArgs: [...multiplexArgs(), ...this.target(host)],
      iconPath: new vscode.ThemeIcon('remote'),
    });
  }

  /** Raízes que saíram do workspace: fecham o terminal delas, e o shell do host se não sobrou raiz. */
  private foldersChanged(event: vscode.WorkspaceFoldersChangeEvent): void {
    for (const removed of event.removed) {
      if (removed.uri.scheme !== SSH_SCHEME) continue;
      const alias = removed.uri.authority;
      this.terminals.get(rootKey(alias, removed.uri.path))?.dispose();
      this.terminals.delete(rootKey(alias, removed.uri.path));
      if (this.roots(alias).length === 0) this.fs.closeShell(alias);
    }
    this.changed.fire(undefined);
  }

  disconnected(): void {
    this.client = undefined;
    this.hosts = [];
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  async reload(): Promise<void> {
    if (!this.client) return;
    this.hosts = await this.client.request<SshHostInfo[]>('ssh.hosts.list').catch(() => []);
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node?.t === 'group') return node.hosts.map((host) => ({ t: 'host', host }));
    if (node) return [];
    if (!this.client) return [{ t: 'info', label: l10n.t('The FaKL Core is not responding.') }];
    if (this.hosts.length === 0) {
      return [{ t: 'info', label: l10n.t('No hosts. Use + or edit ~/.ssh/config.') }];
    }
    const groups = new Map<string, SshHostInfo[]>();
    const loose: SshHostInfo[] = [];
    for (const host of this.hosts) {
      if (host.grupos.length === 0) loose.push(host);
      for (const group of host.grupos) groups.set(group, [...(groups.get(group) ?? []), host]);
    }
    return [
      ...[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, hosts]): Node => ({
          t: 'group',
          name,
          hosts,
        })),
      ...loose.map((host): Node => ({ t: 'host', host })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.t === 'info') return new vscode.TreeItem(node.label);
    if (node.t === 'group') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const { host } = node;
    const inWorkspace = this.roots(host.alias);
    const item = new vscode.TreeItem(host.alias);
    item.description = [
      host.user ? `${host.user}@${host.hostname ?? ''}` : host.hostname,
      host.tags.length > 0 ? `#${host.tags.join(' #')}` : '',
      inWorkspace.length > 0
        ? l10n.t('in workspace: {0}', inWorkspace.map((r) => r.path).join(', '))
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(host.origem === 'hostinger' ? 'cloud' : 'server');
    item.contextValue = `${host.origem === 'config' ? 'ssh-config' : 'ssh-own'}${inWorkspace.length > 0 ? ' ws' : ''}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${host.alias}** (${host.origem})\n\n`);
    tooltip.appendMarkdown(
      `$(${POLICY_ICON[host.politica]}) ${l10n.t('Agents: {0}', policyName(host.politica))}\n\n`,
    );
    if (host.hostname)
      tooltip.appendMarkdown(`${host.hostname}${host.port ? `:${String(host.port)}` : ''}\n\n`);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = {
      command: 'fakl.ssh.terminal',
      title: l10n.t('Open terminal'),
      arguments: [node],
    };
    return item;
  }

  private async pickHost(node?: Node): Promise<SshHostInfo | undefined> {
    if (node?.t === 'host') return node.host;
    await this.reload();
    const picked = await vscode.window.showQuickPick(
      this.hosts.map((host) => ({
        label: host.alias,
        description: host.hostname ?? '',
        detail: l10n.t('agents: {0}', policyName(host.politica)),
        host,
      })),
      { title: l10n.t('SSH host') },
    );
    return picked?.host;
  }

  /** Argumentos do ssh para o terminal: alias do config ou endereço completo. */
  private target(host: SshHostInfo): string[] {
    if (host.origem === 'config') return [host.alias];
    return [
      ...(host.port ? ['-p', String(host.port)] : []),
      ...(host.identityFile ? ['-i', host.identityFile] : []),
      `${host.user ? `${host.user}@` : ''}${host.hostname ?? host.alias}`,
    ];
  }

  /** Clique no host: terminal na pasta remota dele, se está no workspace; senão, no host. */
  private async terminal(node?: Node, plain = false): Promise<void> {
    const host = await this.pickHost(node);
    if (!host) return;
    const roots = this.roots(host.alias);
    if (!plain && roots.length > 0) {
      const root = await this.pickRoot(
        roots,
        l10n.t('Terminal in which folder of {0}?', host.alias),
      );
      if (root) await this.rootTerminal(root.alias, root.path);
      return;
    }
    const key = `host:${host.alias}`;
    const existing = this.terminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `SSH ${host.alias}`,
      shellPath: 'ssh',
      shellArgs: [...multiplexArgs(), ...this.target(host)],
      iconPath: new vscode.ThemeIcon('remote'),
    });
    this.terminals.set(key, terminal);
    terminal.show();
  }

  /**
   * Pasta remota nativa (RF-504, ADR 0019): entra como raiz adicional do
   * workspace desta mesma janela (multi-root), sem extensão e sem instalar nada
   * no servidor. "Nova janela" fica como opção secundária.
   */
  private async addToWorkspace(node: Node | undefined, mode: 'ask' | 'new-window'): Promise<void> {
    const host = await this.pickHost(node);
    if (!host) return;
    const folder = await vscode.window.showInputBox({
      title: l10n.t('Folder on {0}', host.alias),
      value: '~',
      prompt: l10n.t('Folder path on the server (~ is your home folder there)'),
      ignoreFocusOut: true,
    });
    if (!folder) return;
    let path: string;
    try {
      path = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: l10n.t('Connecting to {0}…', host.alias),
        },
        async () => {
          const shell = await this.fs.shell(host.alias);
          const home = await shell.homeDir();
          const resolved = folder === '~' ? home : folder.replace(/^~(?=\/)/, home);
          const absolute = resolved.startsWith('/') ? resolved : `${home}/${resolved}`;
          if ((await shell.stat(absolute)).kind !== 'dir') {
            throw new Error(l10n.t('{0} is not a folder', absolute));
          }
          return absolute;
        },
      );
    } catch (error) {
      const text = message(error);
      void vscode.window.showErrorMessage(
        /Permission denied \(publickey|BatchMode/i.test(text)
          ? l10n.t(
              '{0}: the server did not accept your SSH key. The remote folder connects without a password; use "Generate SSH key" and copy the public key to the server.',
              host.alias,
            )
          : `${host.alias}: ${text}`,
      );
      return;
    }
    const uri = vscode.Uri.from({ scheme: SSH_SCHEME, authority: host.alias, path });
    let newWindow = mode === 'new-window';
    if (!newWindow) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(add) ${l10n.t('Add to this workspace')}`,
            description: l10n.t('recommended: opens as an extra folder in this same window'),
            newWindow: false,
          },
          {
            label: `$(multiple-windows) ${l10n.t('Open in new window')}`,
            description: l10n.t('only this folder, in a separate window'),
            newWindow: true,
          },
        ],
        { title: remoteName(host.alias, path) },
      );
      if (!choice) return;
      newWindow = choice.newWindow;
    }
    if (newWindow) {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      return;
    }
    const outcome = addRemoteFolder(
      vscode.workspace,
      (alias, folder) => vscode.Uri.from({ scheme: SSH_SCHEME, authority: alias, path: folder }),
      host.alias,
      path,
    );
    if (outcome.kind === 'exists') {
      void vscode.window.showInformationMessage(
        l10n.t('{0} is already in the workspace.', remoteName(host.alias, path)),
      );
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    if (outcome.kind === 'failed') {
      void vscode.window.showErrorMessage(
        l10n.t('Could not add {0} to the workspace.', remoteName(host.alias, path)),
      );
      return;
    }
    this.changed.fire(undefined);
    // Com no máximo uma pasta, a IDE troca o tipo de workspace e pode reiniciar as extensões:
    // a pasta já está salva, então depois do reinício tudo continua; só o aviso se perde.
    const text = outcome.mayRestartExtensionHost
      ? l10n.t(
          '{0} added. The IDE may reload its extensions for a moment.',
          remoteName(host.alias, path),
        )
      : l10n.t('{0} added to the workspace.', remoteName(host.alias, path));
    const openTerminal = l10n.t('Open terminal');
    const action = await vscode.window.showInformationMessage(text, openTerminal);
    if (action === openTerminal) await this.rootTerminal(host.alias, path);
  }

  private async removeFromWorkspace(arg?: Node | vscode.Uri): Promise<void> {
    const root = await this.rootFor(arg, l10n.t('Remove which remote folder from the workspace?'));
    if (!root) {
      void vscode.window.showInformationMessage(l10n.t('No SSH folder in the workspace.'));
      return;
    }
    if (!removeRemoteFolder(vscode.workspace, root.alias, root.path)) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not remove {0} from the workspace.', remoteName(root.alias, root.path)),
      );
    }
  }

  private async exec(node?: Node): Promise<void> {
    const host = await this.pickHost(node);
    if (!host || !this.client) return;
    const command = await vscode.window.showInputBox({
      title: l10n.t('Run on {0}', host.alias),
      prompt: l10n.t('The command runs through the system ssh and goes to the audit log.'),
      ignoreFocusOut: true,
    });
    if (!command) return;
    this.output.show(true);
    this.output.appendLine(`$ ssh ${host.alias} ${command}`);
    try {
      const result = await this.client.request<SshExecResult>('ssh.exec', {
        host: host.alias,
        comando: command,
      });
      if (result.saida)
        this.output.append(result.saida.endsWith('\n') ? result.saida : `${result.saida}\n`);
      if (result.erro)
        this.output.append(result.erro.endsWith('\n') ? result.erro : `${result.erro}\n`);
      this.output.appendLine(
        `${l10n.t('(exit code {0}, {1} ms)', String(result.codigo), String(result.duracaoMs))}\n`,
      );
    } catch (error) {
      this.output.appendLine(`${l10n.t('error: {0}', message(error))}\n`);
    }
  }

  private async policy(node?: Node): Promise<void> {
    const host = await this.pickHost(node);
    if (!host || !this.client) return;
    const picked = await vscode.window.showQuickPick(
      policies().map((p) => ({
        ...p,
        picked: p.value === host.politica,
        description: p.value === host.politica ? l10n.t('current') : '',
      })),
      { title: l10n.t('Agent policy on {0}', host.alias) },
    );
    if (!picked) return;
    await this.update({ alias: host.alias, politica: picked.value });
  }

  private async tags(node?: Node): Promise<void> {
    const host = await this.pickHost(node);
    if (!host) return;
    const grupos = await vscode.window.showInputBox({
      title: l10n.t('Groups for {0}', host.alias),
      prompt: l10n.t('Comma-separated, e.g. production, clients'),
      value: host.grupos.join(', '),
    });
    if (grupos === undefined) return;
    const tags = await vscode.window.showInputBox({
      title: l10n.t('Tags for {0}', host.alias),
      prompt: l10n.t('Comma-separated'),
      value: host.tags.join(', '),
    });
    if (tags === undefined) return;
    await this.update({ alias: host.alias, grupos: csv(grupos), tags: csv(tags) });
  }

  private async add(): Promise<void> {
    const alias = await vscode.window.showInputBox({
      title: l10n.t('New host (1/3)'),
      prompt: l10n.t('Short name, e.g. site-prod'),
      validateInput: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)
          ? undefined
          : l10n.t('Letters, numbers, dot, hyphen and _'),
    });
    if (!alias) return;
    const address = await vscode.window.showInputBox({
      title: l10n.t('New host (2/3)'),
      prompt: l10n.t('user@address[:port]'),
      placeHolder: 'deploy@203.0.113.10:22',
    });
    if (!address) return;
    const match = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(address.trim());
    if (!match?.[2]) {
      void vscode.window.showErrorMessage(l10n.t('Invalid address.'));
      return;
    }
    const policy = await vscode.window.showQuickPick(policies(), {
      title: l10n.t('New host (3/3): agent policy'),
    });
    await this.update({
      alias,
      hostname: match[2],
      ...(match[1] ? { user: match[1] } : {}),
      ...(match[3] ? { port: Number(match[3]) } : {}),
      politica: policy?.value ?? 'confirmar',
    });
  }

  private async remove(node?: Node): Promise<void> {
    const host = await this.pickHost(node);
    if (!host || !this.client) return;
    const ok = await vscode.window.showWarningMessage(
      l10n.t('Remove {0} from the manager?', host.alias),
      { modal: true },
      l10n.t('Remove'),
    );
    if (!ok) return;
    try {
      await this.client.request('ssh.hosts.delete', { alias: host.alias });
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(message(error));
    }
  }

  private keygen(): void {
    const terminal = vscode.window.createTerminal({ name: 'ssh-keygen' });
    terminal.show();
    terminal.sendText('ssh-keygen -t ed25519 -C "fakl-code" -f ~/.ssh/id_ed25519_fakl', false);
  }

  private async update(change: Record<string, unknown>): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request('ssh.hosts.upsert', change);
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not save: {0}', message(error)));
    }
  }
}
