import * as vscode from 'vscode';

/**
 * Multi-monitor (ADR 0034): partes da IDE em janelas próprias, que o usuário
 * arrasta para outro monitor. Usa as janelas auxiliares do VS Code (as mesmas
 * de "Mover editor para nova janela"), que ficam no mesmo processo, dividem o
 * estado com a janela principal e voltam no mesmo lugar ao reabrir a IDE.
 */

/** Espera o painel virar o editor ativo, para o comando do VS Code movê-lo. */
function untilActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 2000);
    const listener = panel.onDidChangeViewState(() => {
      if (panel.active) done();
    });
    function done(): void {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    }
  });
}

/** Leva um painel (Mesa, chat, café) para uma janela nova, fora da principal. */
export async function moveToNewWindow(panel: vscode.WebviewPanel): Promise<void> {
  panel.reveal(undefined, false);
  await untilActive(panel);
  if (!panel.active) return;
  await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
}

/** Comandos de janela que não dependem de uma parte da IDE em especial. */
export function registerWindowCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('fakl.janela.editor', () =>
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'),
    ),
    vscode.commands.registerCommand('fakl.janela.grupo', () =>
      vscode.commands.executeCommand('workbench.action.moveEditorGroupToNewWindow'),
    ),
    vscode.commands.registerCommand('fakl.janela.terminal', () =>
      vscode.commands.executeCommand(
        vscode.window.activeTerminal
          ? 'workbench.action.terminal.moveIntoNewWindow'
          : 'workbench.action.terminal.newInNewWindow',
      ),
    ),
    vscode.commands.registerCommand('fakl.janela.vazia', () =>
      vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow'),
    ),
    vscode.commands.registerCommand('fakl.janela.voltar', () =>
      vscode.commands.executeCommand('workbench.action.restoreEditorsToMainWindow'),
    ),
  );
}
