import { randomUUID } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { EmailAccountRef, EmailMessage, EmailMessageSummary } from '@fakl/protocol';
import * as vscode from 'vscode';

interface StoredAccount extends EmailAccountRef {
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

interface EmailNode {
  readonly kind: 'account' | 'message' | 'connect';
  readonly account?: StoredAccount;
  readonly message?: EmailMessageSummary;
}

const ACCOUNTS = 'fakl.email.accounts';
const SECRET_PREFIX = 'fakl.email.password.';

/** Caixa IMAP nativa da IDE; somente metadados ficam em globalState. */
export class EmailUi implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private readonly tree: vscode.TreeView<EmailNode>;
  private client: CoreClient | undefined;
  private readonly messages = new Map<string, EmailMessageSummary[]>();

  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tree = vscode.window.createTreeView('fakl.email.inbox', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.tree,
      vscode.commands.registerCommand('fakl.email.addAccount', () => this.addAccount()),
      vscode.commands.registerCommand('fakl.email.refresh', () => this.refresh()),
      vscode.commands.registerCommand('fakl.email.open', (node: EmailNode) => this.open(node)),
      vscode.commands.registerCommand('fakl.email.removeAccount', (node: EmailNode) =>
        this.removeAccount(node),
      ),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.pushAccounts();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(node: EmailNode): vscode.TreeItem {
    if (node.kind === 'connect') {
      const item = new vscode.TreeItem(l10n.t('Connect an email inbox'));
      item.command = { command: 'fakl.email.addAccount', title: l10n.t('Connect email') };
      return item;
    }
    if (node.kind === 'account' && node.account) {
      const item = new vscode.TreeItem(
        node.account.email,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = l10n.t('{0} · secure IMAP', node.account.host);
      item.contextValue = 'emailAccount';
      item.iconPath = new vscode.ThemeIcon('mail');
      return item;
    }
    const message = node.message;
    const item = new vscode.TreeItem(message?.subject ?? l10n.t('(no subject)'));
    item.description = message?.from ?? '';
    item.tooltip = `${message?.date ?? ''}\n${message?.preview ?? ''}`;
    item.contextValue = 'emailMessage';
    item.iconPath = new vscode.ThemeIcon(message?.unread ? 'mail' : 'mail-read');
    item.command = { command: 'fakl.email.open', title: l10n.t('Open email'), arguments: [node] };
    return item;
  }

  async getChildren(node?: EmailNode): Promise<EmailNode[]> {
    if (!node) {
      const accounts = this.accounts();
      return accounts.length
        ? accounts.map((account) => ({ kind: 'account', account }))
        : [{ kind: 'connect' }];
    }
    if (node.kind !== 'account' || !node.account) return [];
    const account = node.account;
    const cached = this.messages.get(account.id);
    if (cached) return cached.map((message) => ({ kind: 'message', account, message }));
    const client = this.client;
    if (!client) return [];
    try {
      const messages = await client.request<EmailMessageSummary[]>('email.inbox', {
        accountId: account.id,
        limite: 50,
      });
      this.messages.set(account.id, messages);
      return messages.map((message) => ({ kind: 'message', account, message }));
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not load the inbox: {0}', messageOf(error)),
      );
      return [];
    }
  }

  private accounts(): StoredAccount[] {
    return this.context.globalState.get<StoredAccount[]>(ACCOUNTS, []);
  }

  private async addAccount(): Promise<void> {
    if (!this.client) {
      void vscode.window.showWarningMessage(
        l10n.t('The FaKL Core is not connected yet. Try again in a moment.'),
      );
      return;
    }
    const client = this.client;
    const email = await vscode.window.showInputBox({
      title: l10n.t('Connect email'),
      prompt: l10n.t('Inbox address'),
      placeHolder: l10n.t('you@example.com'),
      ignoreFocusOut: true,
    });
    if (!email) return;
    const host = await vscode.window.showInputBox({
      title: l10n.t('IMAP server'),
      prompt: l10n.t('IMAP server with TLS'),
      placeHolder: l10n.t('imap.example.com'),
      ignoreFocusOut: true,
    });
    if (!host) return;
    const username = await vscode.window.showInputBox({
      title: l10n.t('IMAP username'),
      value: email,
      ignoreFocusOut: true,
    });
    if (!username) return;
    const password = await vscode.window.showInputBox({
      title: l10n.t('App password'),
      prompt: l10n.t('The password stays in the IDE’s secure storage.'),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;
    const portText = await vscode.window.showInputBox({
      title: l10n.t('IMAP port'),
      value: '993',
      validateInput: (value) =>
        /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535
          ? undefined
          : l10n.t('Enter a valid port.'),
    });
    if (!portText) return;
    const account: StoredAccount = {
      id: randomUUID(),
      email: email.trim(),
      host: host.trim(),
      port: Number(portText),
      username: username.trim(),
    };
    const next = [...this.accounts(), account];
    await this.context.secrets.store(`${SECRET_PREFIX}${account.id}`, password);
    await this.context.globalState.update(ACCOUNTS, next);
    try {
      await this.configure(next);
      await client.request('email.verify', { accountId: account.id });
      void vscode.window.showInformationMessage(l10n.t('Inbox {0} connected.', account.email));
    } catch (error) {
      await this.context.secrets.delete(`${SECRET_PREFIX}${account.id}`);
      await this.context.globalState.update(
        ACCOUNTS,
        this.accounts().filter((item) => item.id !== account.id),
      );
      await this.configure().catch(() => undefined);
      void vscode.window.showErrorMessage(
        l10n.t('Could not connect the inbox: {0}', messageOf(error)),
      );
    }
    this.changed.fire();
  }

  private async configure(accounts = this.accounts()): Promise<void> {
    const client = this.client;
    if (!client) return;
    const configured = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        password: (await this.context.secrets.get(`${SECRET_PREFIX}${account.id}`)) ?? '',
      })),
    );
    await client.request('email.configure', {
      contas: configured.filter((account) => account.password),
    });
  }

  private async pushAccounts(): Promise<void> {
    await this.configure().catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        l10n.t('Could not make the inboxes available to agents: {0}', messageOf(error)),
      );
    });
    this.messages.clear();
    this.changed.fire();
  }

  private async refresh(): Promise<void> {
    this.messages.clear();
    await this.pushAccounts();
    this.changed.fire();
  }

  private async open(node: EmailNode): Promise<void> {
    if (!node.account || !node.message || !this.client) return;
    try {
      const email = await this.client.request<EmailMessage>('email.read', {
        accountId: node.account.id,
        uid: node.message.uid,
      });
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: [
          `# ${email.subject}`,
          '',
          l10n.t('From: {0}', email.from),
          l10n.t('To: {0}', email.to.join(', ')),
          l10n.t('Date: {0}', email.date),
          '',
          email.text,
        ].join('\n'),
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not open the email: {0}', messageOf(error)),
      );
    }
  }

  private async removeAccount(node: EmailNode): Promise<void> {
    const account = node.account;
    if (!account) return;
    const remove = l10n.t('Remove');
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Remove {0} from the IDE?', account.email),
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    const accounts = this.accounts().filter((item) => item.id !== account.id);
    await this.context.globalState.update(ACCOUNTS, accounts);
    await this.context.secrets.delete(`${SECRET_PREFIX}${account.id}`);
    await this.configure(accounts);
    this.messages.delete(account.id);
    this.changed.fire();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
