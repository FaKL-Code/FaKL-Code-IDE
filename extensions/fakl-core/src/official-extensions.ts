import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import { pendingOfficialExtensions } from './official-extensions-model.js';

const SHOWN = 'fakl.extensoesOficiais.avisadas';
const FIRST_CHECK_MS = 20_000;

/** Avisa, uma vez por extensão, que as conversas das extensões oficiais não entram na Mesa. */
export class OfficialExtensionsNotice implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly subscription: vscode.Disposable;
  private showing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscription = vscode.extensions.onDidChange(() => void this.check());
  }

  start(): void {
    this.timer = setTimeout(() => void this.check(), FIRST_CHECK_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscription.dispose();
  }

  private async check(): Promise<void> {
    if (this.showing) return;
    const shown = this.context.globalState.get<string[]>(SHOWN, []);
    const pending = pendingOfficialExtensions(
      vscode.extensions.all.map((extension) => extension.id),
      shown,
    );
    if (pending.length === 0) return;
    this.showing = true;
    try {
      await this.context.globalState.update(SHOWN, [...shown, ...pending.map((item) => item.id)]);
      const newAgent = l10n.t('New agent');
      const choice = await vscode.window.showInformationMessage(
        l10n.t(
          'The official {0} extension keeps its own conversations, separate from the Desk, the café and the Maestro. Agents started from the IDE show up there and use the same account.',
          pending.map((item) => item.name).join(', '),
        ),
        newAgent,
        l10n.t('Got it'),
      );
      if (choice === newAgent) await vscode.commands.executeCommand('fakl.agents.new');
    } finally {
      this.showing = false;
    }
  }
}
