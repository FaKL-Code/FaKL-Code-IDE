import { randomBytes } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { ProvidersDetectResult, ProvidersEnvironment } from '@fakl/protocol';
import * as vscode from 'vscode';

import {
  actionOf,
  diagnose,
  firstConcern,
  type DoctorAction,
  type DoctorItem,
  type DoctorSnapshot,
} from './doctor-model.js';
import { renderDoctor } from './doctor-view.js';

/** Uma consulta lenta ao npm não segura a tela. */
const CALL_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, CALL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** O que a página devolve: o item e o índice da ação, ou um pedido para olhar de novo. */
type FromDoctor =
  | { readonly type: 'acao'; readonly item: string; readonly indice: number }
  | { readonly type: 'recarregar' };

/**
 * "FaKL: Doctor" (ADR 0040): uma tela que diz, em linguagem simples, o que
 * falta para os agentes rodarem, com a ação de cada item. Não instala nem
 * altera nada: os comandos de instalação vão ao terminal digitados, sem
 * Enter, e o resto são comandos que já pedem confirmação. Também roda uma vez
 * por sessão da IDE quando um agente falha ao iniciar.
 */
export class DoctorUi implements vscode.Disposable {
  private client: CoreClient | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private items: DoctorItem[] = [];
  private offered = false;
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.commands.registerCommand('fakl.doctor.open', () => this.open());
  }

  connected(client: CoreClient): void {
    this.client = client;
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposable.dispose();
  }

  /** Junta o retrato da máquina e aplica as regras. */
  private async check(): Promise<DoctorItem[]> {
    const client = this.client;
    if (!client) return diagnose({ conectado: false });
    const checkUpdates = vscode.workspace
      .getConfiguration('fakl')
      .get<boolean>('providers.checkUpdates', true);
    const [detected, ambiente] = await Promise.all([
      withTimeout(
        client.request<ProvidersDetectResult>('providers.detect', { atualizacoes: checkUpdates }),
      ).catch(() => undefined),
      withTimeout(client.request<ProvidersEnvironment>('providers.environment')).catch(
        () => undefined,
      ),
    ]);
    const snapshot: DoctorSnapshot = {
      conectado: true,
      ...(ambiente ? { ambiente } : {}),
      ...(detected ? { provedores: detected.provedores } : {}),
    };
    return diagnose(snapshot);
  }

  private async open(): Promise<void> {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Active);
    else this.create();
    await this.refresh();
  }

  private create(): void {
    const panel = vscode.window.createWebviewPanel(
      'fakl.doctor',
      l10n.t('FaKL Doctor'),
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    panel.webview.onDidReceiveMessage((message: FromDoctor) => {
      this.receive(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  private async refresh(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    panel.webview.html = renderDoctor([], {
      nonce: randomBytes(16).toString('base64'),
      cspSource: panel.webview.cspSource,
      language: vscode.env.language,
      loading: true,
    });
    this.items = await this.check();
    if (this.panel !== panel) return;
    panel.webview.html = renderDoctor(this.items, {
      nonce: randomBytes(16).toString('base64'),
      cspSource: panel.webview.cspSource,
      language: vscode.env.language,
      loading: false,
    });
  }

  private async receive(message: FromDoctor): Promise<void> {
    if (message.type === 'recarregar') {
      await this.refresh();
      return;
    }
    // Só roda o que a própria tela ofereceu: a página não escolhe comandos.
    const action = actionOf(this.items, message.item, message.indice);
    if (action) await this.run(action);
  }

  private async run(action: DoctorAction): Promise<void> {
    switch (action.tipo) {
      case 'comando':
        await vscode.commands.executeCommand(action.comando, ...(action.args ?? []));
        // Chave guardada, janela recarregada: relê para o item sumir.
        if (this.panel) await this.refresh();
        return;
      case 'link':
        await vscode.env.openExternal(vscode.Uri.parse(action.url));
        return;
      case 'terminal': {
        // O comando vai digitado, sem Enter: a pessoa confere e roda.
        const terminal = vscode.window.createTerminal({ name: action.nome });
        terminal.show();
        terminal.sendText(action.texto, false);
        return;
      }
    }
  }

  /**
   * Um agente falhou ao iniciar: roda o diagnóstico (uma vez por sessão da
   * IDE) e, se achar algo, junta ao erro o botão "Ver diagnóstico". Sem nada
   * a apontar, não diz nada além do erro que o chamador já mostrou.
   */
  async offerAfterFailure(agent: string, error: unknown): Promise<void> {
    if (this.offered) return;
    this.offered = true;
    const concern = firstConcern(await this.check().catch(() => []));
    if (!concern) return;
    const see = l10n.t('See diagnosis');
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    const answer = await vscode.window.showWarningMessage(
      l10n.t('{0} did not start ({1}). The Doctor found: {2}', agent, reason, concern.titulo),
      see,
    );
    if (answer === see) await this.open();
  }
}
