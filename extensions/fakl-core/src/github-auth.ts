import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import {
  GITHUB_SCOPES,
  GitHubClient,
  pollDeviceToken,
  requestDeviceCode,
} from '@fakl/integrations';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/** Token colado ou vindo do gh/device flow, no SecretStorage da IDE (cifrado pelo sistema). */
const STORED_TOKEN = 'fakl.github.token';

type Source = 'conta' | 'guardado';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Login no GitHub uma vez para a IDE, o git e os agentes (RF-501, ADR 0010).
 * A fonte preferida é a conta do GitHub da própria IDE (menu Contas), a mesma
 * que o git embutido e o sync de configurações usam. Sem ela, vale um token
 * guardado no SecretStorage: do gh CLI, colado ou do device flow do OAuth App
 * da FaKL-Code. O token vai ao Core em memória, a cada conexão.
 */
export class GitHubAuth implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private client: CoreClient | undefined;
  private token: string | undefined;
  private source: Source | undefined;
  /** Login do usuário, depois da primeira consulta. */
  user: string | undefined;
  readonly api: GitHubClient;
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.api = new GitHubClient({ token: () => this.token, userAgent: 'FaKL-Code IDE' });
    this.disposables.push(
      this.changed,
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === 'github') void this.load(false);
      }),
      context.secrets.onDidChange((event) => {
        if (event.key === STORED_TOKEN) void this.load(false);
      }),
      vscode.commands.registerCommand('fakl.github.login', () => this.login()),
      vscode.commands.registerCommand('fakl.github.logout', () => this.logout()),
    );
    void this.load(false);
  }

  get signedIn(): boolean {
    return Boolean(this.token);
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.push();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Lê o token atual (conta da IDE primeiro) e avisa quem depende dele. */
  async load(interactive: boolean): Promise<boolean> {
    let token: string | undefined;
    let source: Source | undefined;
    try {
      // Um login antigo só com `repo` (o do sync de configurações) também serve.
      const session =
        (await vscode.authentication.getSession('github', GITHUB_SCOPES, {
          ...(interactive ? { createIfNone: true } : { silent: true }),
        })) ?? (await vscode.authentication.getSession('github', ['repo'], { silent: true }));
      if (session) {
        token = session.accessToken;
        source = 'conta';
      }
    } catch (error) {
      if (interactive) throw error;
    }
    if (!token) {
      token = await this.context.secrets.get(STORED_TOKEN);
      if (token) source = 'guardado';
    }
    const before = this.token;
    this.token = token;
    this.source = source;
    if (before !== token) {
      this.user = undefined;
      if (token) {
        this.user = await this.api
          .user()
          .then((user) => user.login)
          .catch(() => undefined);
      }
      await this.push();
      this.changed.fire();
    }
    return Boolean(token);
  }

  private async push(): Promise<void> {
    await this.client
      ?.request('secrets.set', { nome: 'github.token', valor: this.token ?? null })
      .catch(() => undefined);
  }

  /** Garante um login, perguntando como quando não há. */
  async ensure(): Promise<boolean> {
    return this.token ? true : this.login();
  }

  async login(): Promise<boolean> {
    const clientId = vscode.workspace
      .getConfiguration('fakl.github')
      .get<string>('clientId', '')
      .trim();
    const options: (vscode.QuickPickItem & { id: string })[] = [
      {
        id: 'conta',
        label: l10n.t('$(github) Sign in with your GitHub account'),
        detail: l10n.t('Sign in through the browser; also works for git and settings sync.'),
      },
      ...(clientId
        ? [
            {
              id: 'device',
              label: l10n.t('$(key) Sign in with a code (device flow)'),
              detail: l10n.t('Enter a code at github.com/login/device.'),
            },
          ]
        : []),
      {
        id: 'gh',
        label: l10n.t('$(terminal) Use the gh CLI sign-in'),
        detail: l10n.t('Copies the token from `gh auth token`, if gh is signed in.'),
      },
      {
        id: 'pat',
        label: l10n.t('$(lock) Paste a personal access token'),
        detail: l10n.t(
          'Classic: repo, workflow, notifications and read:org. Fine-grained: All repositories, read access to Metadata, Pull requests, Issues and Actions (no notifications). With SSO, authorize the token in the organization.',
        ),
      },
    ];
    const picked = await vscode.window.showQuickPick(options, {
      title: l10n.t('Sign in to GitHub'),
      placeHolder: this.user
        ? l10n.t('Signed in as {0}', this.user)
        : l10n.t('How do you want to sign in?'),
    });
    if (!picked) return false;
    try {
      switch (picked.id) {
        case 'conta':
          return await this.load(true);
        case 'device':
          return await this.deviceFlow(clientId);
        case 'gh': {
          const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 15_000 });
          return await this.store(stdout.trim());
        }
        default: {
          const token = await vscode.window.showInputBox({
            title: l10n.t('GitHub token'),
            prompt: l10n.t('Kept in the system keychain (Keychain or DPAPI), never in a file.'),
            password: true,
            ignoreFocusOut: true,
          });
          return token ? await this.store(token.trim()) : false;
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t("Couldn't sign in to GitHub: {0}", message(error)),
      );
      return false;
    }
  }

  private async deviceFlow(clientId: string): Promise<boolean> {
    const code = await requestDeviceCode(clientId);
    await vscode.env.clipboard.writeText(code.userCode);
    void vscode.env.openExternal(vscode.Uri.parse(code.verificationUri));
    const token = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: l10n.t('Enter the code {0} on GitHub (already copied)', code.userCode),
        cancellable: true,
      },
      (_progress, cancel) => {
        const abort = new AbortController();
        cancel.onCancellationRequested(() => {
          abort.abort();
        });
        return pollDeviceToken(clientId, code, { signal: abort.signal });
      },
    );
    return this.store(token);
  }

  /** Confere o token na API e guarda no SecretStorage. */
  private async store(token: string): Promise<boolean> {
    if (!token) throw new Error(l10n.t('empty token'));
    const probe = new GitHubClient({ token: () => token });
    const user = await probe.user();
    await this.context.secrets.store(STORED_TOKEN, token);
    await this.load(false);
    void vscode.window
      .showInformationMessage(
        l10n.t(
          'GitHub connected as {0}. To check organizations with SSO, use Diagnose access.',
          user.login,
        ),
        l10n.t('Diagnose access'),
      )
      .then((pick) => {
        if (pick) void vscode.commands.executeCommand('fakl.github.diagnose');
      });
    return true;
  }

  async logout(): Promise<void> {
    await this.context.secrets.delete(STORED_TOKEN);
    await this.load(false);
    if (this.source === 'conta') {
      void vscode.window.showInformationMessage(
        l10n.t(
          'The stored token was deleted. To sign out of the IDE GitHub account, use the Accounts menu (person icon in the sidebar).',
        ),
      );
    } else {
      void vscode.window.showInformationMessage(l10n.t('You signed out of GitHub in FaKL-Code.'));
    }
  }
}
