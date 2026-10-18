import * as vscode from 'vscode';

import { AUTOMATIC_QUERIES_SETTING, type NetworkSettings } from './rede-model.js';

/** Lê das configurações da IDE o que decide as consultas automáticas (ADR 0045). */
export function readNetworkSettings(): NetworkSettings {
  const fakl = vscode.workspace.getConfiguration('fakl');
  const mode = vscode.workspace.getConfiguration('update').get<string>('mode');
  return {
    automatic: fakl.get<boolean>(AUTOMATIC_QUERIES_SETTING, true),
    adapterCheck: fakl.get<boolean>('providers.checkUpdates', true),
    updateNotify: fakl.get<boolean>('update.notify', true),
    ...(mode ? { updateMode: mode } : {}),
  };
}
