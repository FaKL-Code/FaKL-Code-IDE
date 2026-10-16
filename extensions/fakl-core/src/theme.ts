import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

export const THEME = 'FaKL Noite';
const OFFERED = 'fakl.tema.oferecido';

/**
 * Na primeira abertura com o tema FaKL Noite (ADR 0017): quem nunca escolheu
 * um tema passa a usá-lo; quem já tem um ganha um convite, uma vez só.
 */
export async function offerTheme(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(OFFERED)) return;
  await context.globalState.update(OFFERED, true);
  const config = vscode.workspace.getConfiguration('workbench');
  const current = config.inspect<string>('colorTheme');
  if (current?.globalValue === THEME || current?.workspaceValue === THEME) return;
  if (current?.globalValue === undefined && current?.workspaceValue === undefined) {
    await config.update('colorTheme', THEME, vscode.ConfigurationTarget.Global);
    return;
  }
  const usar = l10n.t('Use {0}', THEME);
  const choice = await vscode.window.showInformationMessage(
    l10n.t(
      'FaKL-Code has a new theme, {0}, with the same look as the Desk. Want to use it?',
      THEME,
    ),
    usar,
    l10n.t('Not now'),
  );
  if (choice === usar) {
    await config.update('colorTheme', THEME, vscode.ConfigurationTarget.Global);
  }
}

/** Mesa em foco: abre a Mesa e recolhe as barras laterais e o painel. */
export async function focusMesa(): Promise<void> {
  await vscode.commands.executeCommand('fakl.mesa.open');
  for (const command of [
    'workbench.action.closeSidebar',
    'workbench.action.closeAuxiliaryBar',
    'workbench.action.closePanel',
  ]) {
    await vscode.commands.executeCommand(command).then(undefined, () => undefined);
  }
}
