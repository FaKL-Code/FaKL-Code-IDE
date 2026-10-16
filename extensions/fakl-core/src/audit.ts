import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

interface Entry {
  readonly ts: string;
  readonly ator: string;
  readonly acao: string;
  readonly alvo?: string;
  readonly resultado: string;
  readonly detalhes?: Record<string, unknown>;
}

const ICON: Record<string, string> = {
  ok: 'pass',
  aprovado: 'check',
  erro: 'error',
  negado: 'circle-slash',
  recusado: 'lock',
};

/** Auditoria na IDE (SDD 14.4): últimas ações sensíveis e conferência da corrente. */
export function registerAudit(client: () => CoreClient | undefined): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('fakl.audit.show', async () => {
      const core = client();
      if (!core) return;
      const entries = await core.request<Entry[]>('audit.list', { limite: 200 });
      const picked = await vscode.window.showQuickPick(
        entries.map((e) => ({
          label: `$(${ICON[e.resultado] ?? 'circle-outline'}) ${e.acao} ${e.alvo ?? ''}`,
          description: `${e.ator} · ${new Date(e.ts).toLocaleString()}`,
          detail: e.detalhes ? JSON.stringify(e.detalhes) : e.resultado,
          entry: e,
        })),
        {
          title: l10n.t('Audit log'),
          matchOnDetail: true,
          placeHolder: l10n.t('Sensitive actions, newest first'),
        },
      );
      if (picked) {
        const document = await vscode.workspace.openTextDocument({
          content: JSON.stringify(picked.entry, null, 2),
          language: 'json',
        });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    }),
    vscode.commands.registerCommand('fakl.audit.verify', async () => {
      const core = client();
      if (!core) return;
      const result = await core.request<{ ok: boolean; entradas: number; quebraEm?: string }>(
        'audit.verify',
      );
      if (result.ok) {
        void vscode.window.showInformationMessage(
          result.entradas === 1
            ? l10n.t('Audit log intact: 1 entry.')
            : l10n.t('Audit log intact: {0} entries.', String(result.entradas)),
        );
      } else {
        void vscode.window.showErrorMessage(
          l10n.t('The audit log was altered starting at entry {0}.', result.quebraEm ?? '?'),
        );
      }
    }),
  );
}
