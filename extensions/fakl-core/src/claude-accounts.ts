import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  AgentProfileEntry,
  ClaudeAccountEventData,
  ClaudeAccountInfo,
  ClaudeAccountLogin,
  ClaudeAccountSlot,
  ClaudeAccountsState,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { planTerminalReopen } from './claude-terminal.js';

function money(usd: number): string {
  return l10n.t('${0}', usd.toFixed(2));
}

/** Quantos terminais reabriram e quantos ficaram de fora na troca de conta. */
function reopenSummary(reopened: number, skipped: number): string {
  if (reopened === 1) {
    return skipped === 1
      ? l10n.t('1 terminal reopened; 1 left out. Sign-in, SSH and extension terminals stay open.')
      : l10n.t(
          '1 terminal reopened; {0} left out. Sign-in, SSH and extension terminals stay open.',
          skipped,
        );
  }
  return skipped === 1
    ? l10n.t(
        '{0} terminals reopened; 1 left out. Sign-in, SSH and extension terminals stay open.',
        reopened,
      )
    : l10n.t(
        '{0} terminals reopened; {1} left out. Sign-in, SSH and extension terminals stay open.',
        reopened,
        skipped,
      );
}

/** Ambiente do processo da extensão, para terminais com `strictEnv`. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Contas do Claude (ADR 0021): até três logins lado a lado, cada um numa pasta
 * de configuração própria. A IDE nunca lê as credenciais; o login roda no
 * terminal e o estado vem do `claude auth status` pelo Core.
 */
export class ClaudeAccountsUi
  implements vscode.TreeDataProvider<ClaudeAccountInfo>, vscode.Disposable
{
  private state: ClaudeAccountsState = { contas: [] };
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status: vscode.StatusBarItem;
  private client: CoreClient | undefined;
  private reloadGeneration = 0;
  private readonly loginTerminals = new Map<vscode.Terminal, ClaudeAccountSlot>();

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    router: AgentEventRouter,
  ) {
    this.status = vscode.window.createStatusBarItem(
      'fakl.claude.account',
      vscode.StatusBarAlignment.Right,
      198,
    );
    this.status.name = l10n.t('Active Claude account');
    this.status.command = 'fakl.claude.switch';
    this.context.environmentVariableCollection.description = l10n.t(
      'Active Claude Code account in new terminals. Reopen existing terminals to apply the switch.',
    );
    this.render();
    this.disposables.push(
      this.changed,
      this.status,
      vscode.window.createTreeView('fakl.claude.accounts', { treeDataProvider: this }),
      router.listen((event) => {
        if (event.topic === 'agent.state') void this.reload();
        if (event.topic === 'claude.account') {
          void this.onAccountChanged(event.data as ClaudeAccountEventData);
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        // Terminou o login: confere o estado da conta.
        if (this.loginTerminals.delete(terminal)) void this.reload();
      }),
      vscode.commands.registerCommand('fakl.claude.login', (a?: ClaudeAccountInfo) =>
        this.login(a),
      ),
      vscode.commands.registerCommand('fakl.claude.logout', (a?: ClaudeAccountInfo) =>
        this.logout(a),
      ),
      vscode.commands.registerCommand('fakl.claude.rename', (a?: ClaudeAccountInfo) =>
        this.rename(a),
      ),
      vscode.commands.registerCommand('fakl.claude.setActive', (a?: ClaudeAccountInfo) =>
        this.setActive(a),
      ),
      vscode.commands.registerCommand('fakl.claude.switch', () => this.switchAccount()),
      vscode.commands.registerCommand('fakl.claude.useDefault', () => this.applyActive(null)),
      vscode.commands.registerCommand('fakl.claude.refresh', () => this.reload()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(account: ClaudeAccountInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(account.apelido);
    item.id = `claude-${String(account.slot)}`;
    const quem =
      account.logada === true
        ? (account.email ?? l10n.t('signed in'))
        : account.logada === false
          ? l10n.t('signed out')
          : l10n.t('unknown state');
    item.description = [
      account.ativa ? l10n.t('active') : '',
      quem,
      account.plano ?? '',
      account.uso.custoUsd > 0 ? money(account.uso.custoUsd) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(l10n.t('**{0}** (account {1})', account.apelido, account.slot) + '\n\n');
    tooltip.appendMarkdown(
      account.plano
        ? l10n.t('State: {0} · plan {1}', quem, account.plano)
        : l10n.t('State: {0}', quem),
    );
    const tokens = account.uso.tokensEntrada + account.uso.tokensSaida;
    tooltip.appendMarkdown(
      '\n\n' + l10n.t('Today: {0} tokens, {1}', tokens, money(account.uso.custoUsd)),
    );
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(
      account.ativa ? 'check' : account.logada ? 'account' : 'circle-outline',
    );
    item.contextValue = account.logada ? 'fakl.claude.account.in' : 'fakl.claude.account.out';
    item.command = account.logada
      ? {
          command: 'fakl.claude.setActive',
          title: l10n.t('Use this account'),
          arguments: [account],
        }
      : {
          command: 'fakl.claude.login',
          title: l10n.t('Sign in to this account'),
          arguments: [account],
        };
    return item;
  }

  getChildren(account?: ClaudeAccountInfo): ClaudeAccountInfo[] {
    return account ? [] : [...this.state.contas];
  }

  /**
   * Conta de um agente novo. Só pergunta se `fakl.claude.perguntarConta` está
   * ligado, o perfil é do Claude e há duas ou mais contas logadas; sem
   * resposta, vale a conta ativa.
   */
  async pickForNewAgent(profileId: string): Promise<ClaudeAccountSlot | undefined> {
    const client = this.client;
    if (!client) return undefined;
    if (!vscode.workspace.getConfiguration('fakl').get<boolean>('claude.perguntarConta', false)) {
      return undefined;
    }
    try {
      const profiles = await client.request<AgentProfileEntry[]>('profiles.list');
      if (profiles.find((p) => p.profile.id === profileId)?.profile.provedor !== 'anthropic') {
        return undefined;
      }
      await this.reload();
    } catch {
      return undefined;
    }
    const logged = this.state.contas.filter((c) => c.logada);
    if (logged.length < 2) return undefined;
    const picked = await vscode.window.showQuickPick(
      logged.map((c) => ({
        label: c.apelido,
        description: [c.ativa ? l10n.t('active') : '', c.email ?? ''].filter(Boolean).join(' · '),
        slot: c.slot,
      })),
      {
        title: l10n.t('Claude account for this agent'),
        placeHolder: l10n.t('Which account to use?'),
      },
    );
    return picked?.slot;
  }

  private async reload(): Promise<void> {
    if (!this.client) return;
    const generation = ++this.reloadGeneration;
    let state: ClaudeAccountsState;
    try {
      state = await this.client.request<ClaudeAccountsState>('claude.accounts.list');
    } catch {
      return;
    }
    if (generation !== this.reloadGeneration) return;
    this.state = state;
    this.applyTerminalEnvironment(this.environmentFromState());
    this.render();
  }

  private render(): void {
    this.changed.fire(undefined);
    const active = this.activeAccount();
    this.status.text = `$(account) ${active?.apelido ?? l10n.t('Default Claude')}`;
    if (active) {
      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**${active.apelido}**\n\n`);
      tooltip.appendMarkdown(l10n.t('Email: {0}', active.email ?? l10n.t('not provided')) + '\n\n');
      tooltip.appendMarkdown(l10n.t('Plan: {0}', active.plano ?? l10n.t('not provided')));
      this.status.tooltip = tooltip;
    } else {
      this.status.tooltip = l10n.t('Default Claude CLI account');
    }
    this.status.show();
  }

  private activeAccount(): ClaudeAccountInfo | undefined {
    return this.state.contas.find((account) => account.slot === this.state.ativa);
  }

  private environmentFromState(): Readonly<Record<string, string>> {
    const dir = this.activeAccount()?.dir;
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  }

  private applyTerminalEnvironment(env: Readonly<Record<string, string>>): void {
    const dir = env.CLAUDE_CONFIG_DIR;
    if (dir) this.context.environmentVariableCollection.replace('CLAUDE_CONFIG_DIR', dir);
    else this.context.environmentVariableCollection.delete('CLAUDE_CONFIG_DIR');
  }

  private async onAccountChanged(data: ClaudeAccountEventData): Promise<void> {
    this.applyTerminalEnvironment(data.env);
    this.state = {
      ...(data.ativa ? { ativa: data.ativa } : {}),
      contas: this.state.contas.map((account) => ({
        ...account,
        ativa: account.slot === data.ativa,
      })),
    };
    this.render();
    await this.reload();
    const nome = data.ativa
      ? (this.state.contas.find((account) => account.slot === data.ativa)?.apelido ??
        l10n.t('Account {0}', data.ativa))
      : l10n.t('Default Claude');
    const quantidade = data.sessoes.length;
    const reopen = l10n.t('Reopen terminals');
    const action = await vscode.window.showInformationMessage(
      quantidade === 1
        ? l10n.t('Now using {0} in 1 agent and in new terminals.', nome)
        : l10n.t('Now using {0} in {1} agents and in new terminals.', nome, quantidade),
      reopen,
    );
    if (action === reopen) {
      const { reopened, skipped } = this.reopenTerminals();
      void vscode.window.showInformationMessage(reopenSummary(reopened, skipped));
    }
  }

  private reopenTerminals(): { reopened: number; skipped: number } {
    let reopened = 0;
    let skipped = 0;
    const configDir = this.environmentFromState().CLAUDE_CONFIG_DIR;
    for (const terminal of vscode.window.terminals) {
      const plan = planTerminalReopen(
        terminal.creationOptions,
        configDir,
        this.loginTerminals.has(terminal),
      );
      if (plan.kind === 'skip') {
        skipped++;
        continue;
      }
      try {
        const active = vscode.window.activeTerminal === terminal;
        const replacement = vscode.window.createTerminal(plan.options);
        terminal.dispose();
        if (active) replacement.show();
        reopened++;
      } catch {
        // O original só é fechado depois da criação; numa falha, fica intacto.
        skipped++;
      }
    }
    return { reopened, skipped };
  }

  private async choose(
    account: ClaudeAccountInfo | undefined,
    title: string,
  ): Promise<ClaudeAccountInfo | undefined> {
    if (account) return account;
    const picked = await vscode.window.showQuickPick(
      this.state.contas.map((c) => ({ label: c.apelido, description: c.email ?? '', account: c })),
      { title },
    );
    return picked?.account;
  }

  private async login(target?: ClaudeAccountInfo): Promise<void> {
    if (!this.client) return;
    const account = await this.choose(target, l10n.t('Sign in to which account?'));
    if (!account) return;
    const prep = await this.client.request<ClaudeAccountLogin>('claude.accounts.prepare', {
      slot: account.slot,
    });
    // strictEnv: sem ele, a coleção de ambiente da extensão (conta ativa) sobrescreveria o
    // CLAUDE_CONFIG_DIR deste terminal e o login cairia na conta errada.
    const terminal = vscode.window.createTerminal({
      name: `Claude: ${account.apelido}`,
      env: { ...inheritedEnv(), ...prep.env },
      strictEnv: true,
    });
    this.loginTerminals.set(terminal, account.slot);
    terminal.show();
    terminal.sendText(prep.comando);
    void vscode.window.showInformationMessage(
      l10n.t(
        'Finish signing in to "{0}" in the terminal, then close it; the account updates when it closes.',
        account.apelido,
      ),
    );
  }

  private async logout(target?: ClaudeAccountInfo): Promise<void> {
    if (!this.client) return;
    const account = await this.choose(target, l10n.t('Sign out of which account?'));
    if (!account) return;
    const signOut = l10n.t('Sign out');
    const ok = await vscode.window.showWarningMessage(
      l10n.t('Sign out of "{0}"?', account.apelido),
      { modal: true },
      signOut,
    );
    if (ok !== signOut) return;
    try {
      this.state = await this.client.request<ClaudeAccountsState>('claude.accounts.logout', {
        slot: account.slot,
      });
      this.applyTerminalEnvironment(this.environmentFromState());
      this.render();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async rename(target?: ClaudeAccountInfo): Promise<void> {
    if (!this.client) return;
    const account = await this.choose(target, l10n.t('Rename which account?'));
    if (!account) return;
    const apelido = await vscode.window.showInputBox({
      prompt: l10n.t('Account nickname (empty restores the default)'),
      value: account.apelido,
    });
    if (apelido === undefined) return;
    this.state = await this.client.request<ClaudeAccountsState>('claude.accounts.rename', {
      slot: account.slot,
      apelido,
    });
    this.render();
  }

  private async setActive(target?: ClaudeAccountInfo): Promise<void> {
    const account = await this.choose(target, l10n.t('Which account to use?'));
    if (account) await this.applyActive(account.slot);
  }

  private async switchAccount(): Promise<void> {
    await this.reload();
    type Pick =
      | (vscode.QuickPickItem & { action: 'activate'; slot: ClaudeAccountSlot | null })
      | (vscode.QuickPickItem & { action: 'login' });
    const picks: Pick[] = [
      ...this.state.contas
        .filter((account) => account.logada)
        .map((account): Pick => ({
          label: `${account.ativa ? '$(check)' : '$(account)'} ${account.apelido}`,
          description: [
            account.ativa ? l10n.t('in use') : '',
            account.email ?? '',
            account.plano ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
          action: 'activate',
          slot: account.slot,
        })),
      {
        label: `${this.state.ativa === undefined ? '$(check)' : '$(home)'} ${l10n.t('Default CLI account')}`,
        ...(this.state.ativa === undefined ? { description: l10n.t('in use') } : {}),
        action: 'activate',
        slot: null,
      },
      {
        label: l10n.t('$(sign-in) Sign in to another account…'),
        action: 'login',
      },
    ];
    const picked = await vscode.window.showQuickPick(picks, {
      title: l10n.t('Claude: Switch account'),
      placeHolder: l10n.t('Pick the account used by agents and new terminals'),
    });
    if (!picked) return;
    if (picked.action === 'login') await this.login();
    else await this.applyActive(picked.slot);
  }

  private async applyActive(slot: ClaudeAccountSlot | null): Promise<void> {
    if (!this.client) return;
    try {
      this.state = await this.client.request<ClaudeAccountsState>('claude.accounts.setActive', {
        slot,
        aplicarEmAbertos: true,
      });
      this.applyTerminalEnvironment(this.environmentFromState());
      this.render();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}
