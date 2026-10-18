import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import type { AgentControl } from './agents.js';
import { EMPTY_PROGRESS, SETUP_PROGRESS_KEY, withStep, type SetupProgress } from './setup-model.js';
import {
  pendingTips,
  pickSampleProfile,
  sampleFiles,
  sampleTask,
  TOUR_WALKTHROUGH,
  withTipSeen,
  withTipsOff,
  withTipsReset,
} from './tour-model.js';
import type { FromTips, ToTips, TourSurface } from './tour-protocol.js';

type TipsSource = (webview: vscode.Webview, surface: TourSurface) => vscode.Disposable;

let tipsSource: TipsSource | undefined;

/**
 * Liga as dicas do tour a uma webview da FaKL (painel ou view): quando a página
 * avisa que está pronta, manda as dicas ainda não vistas da tela. Sem o tour
 * ativo, nada.
 */
export function attachTips(
  host: vscode.WebviewPanel | vscode.WebviewView,
  surface: TourSurface,
): void {
  const tips = tipsSource?.(host.webview, surface);
  if (tips) {
    host.onDidDispose(() => {
      tips.dispose();
    });
  }
}

/**
 * Tour da FaKL-Code (ADR 0040): o walkthrough nativo "Conheça a FaKL-Code",
 * os balões dentro das nossas telas e a primeira tarefa guiada. Tudo é
 * pulável e volta pelo comando "FaKL: Tour"; o que já foi visto fica no mesmo
 * progresso da jornada de configuração.
 */
export class TourUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agents: AgentControl,
  ) {
    tipsSource = (webview, surface) => this.attach(webview, surface);
    this.disposables = [
      vscode.commands.registerCommand('fakl.tour.open', () => this.open()),
      vscode.commands.registerCommand('fakl.tour.firstTask', () => this.firstTask()),
      vscode.commands.registerCommand('fakl.tour.resetTips', () => this.resetTips()),
    ];
  }

  dispose(): void {
    tipsSource = undefined;
    for (const disposable of this.disposables) disposable.dispose();
  }

  private get progress(): SetupProgress {
    return this.context.globalState.get<SetupProgress>(SETUP_PROGRESS_KEY, EMPTY_PROGRESS);
  }

  private save(progress: SetupProgress): Thenable<void> {
    return this.context.globalState.update(SETUP_PROGRESS_KEY, progress);
  }

  /** Abre o walkthrough; quem já viu as dicas de uma tela as revê abrindo o tour. */
  private async open(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      TOUR_WALKTHROUGH,
      false,
    );
  }

  private async resetTips(): Promise<void> {
    await this.save(withTipsReset(this.progress));
    void vscode.window.showInformationMessage(
      l10n.t(
        'The tips will show again the next time you open the Desk, the chat, the café or the vault.',
      ),
    );
  }

  attach(webview: vscode.Webview, surface: TourSurface): vscode.Disposable {
    return webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as FromTips;
      switch (message.type) {
        case 'fakl.dicas.pronto': {
          const dicas = pendingTips(surface, this.progress);
          if (dicas.length === 0) return;
          const update: ToTips = {
            type: 'fakl.dicas',
            dicas,
            rotulos: { entendi: l10n.t('Got it'), desligar: l10n.t('Hide all tips') },
          };
          void webview.postMessage(update);
          return;
        }
        case 'fakl.dicas.vista':
          void this.save(withTipSeen(this.progress, message.id));
          return;
        case 'fakl.dicas.desligar':
          void this.save(withTipsOff(this.progress));
          return;
      }
    });
  }

  /**
   * Cria um agente numa pasta de exemplo e abre a Mesa e o café para a pessoa
   * ver os dois reagirem. Pergunta antes, usa um agente já pronto e só pede
   * leitura: nada é instalado nem alterado fora da pasta de exemplo.
   */
  private async firstTask(): Promise<void> {
    let profiles;
    try {
      profiles = await this.agents.detect();
    } catch {
      return;
    }
    const profile = pickSampleProfile(profiles);
    if (!profile) {
      const doctor = l10n.t('Open the Doctor');
      const answer = await vscode.window.showWarningMessage(
        l10n.t(
          'No agent is ready yet, so there is nothing to run. The Doctor shows what is missing.',
        ),
        doctor,
      );
      if (answer === doctor) await vscode.commands.executeCommand('fakl.doctor.open');
      return;
    }
    const start = l10n.t('Start');
    const answer = await vscode.window.showInformationMessage(
      l10n.t(
        'This creates a small sample folder and asks {0} to read it and describe it. The agent only reads, and nothing outside that folder is touched.',
        profile.nome,
      ),
      start,
      l10n.t('Not now'),
    );
    if (answer !== start) return;
    try {
      const folder = path.join(this.context.globalStorageUri.fsPath, 'tour-sample');
      await fs.mkdir(folder, { recursive: true });
      for (const file of sampleFiles()) {
        await fs
          .writeFile(path.join(folder, file.nome), file.conteudo, { flag: 'wx' })
          .catch((error: unknown) => {
            // O arquivo de uma tentativa anterior fica como está.
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
              throw error;
            }
          });
      }
      const sessionId = await this.agents.start(profile.id, false, 'aprovar-leitura', folder);
      await this.agents.send(sessionId, sampleTask());
      await vscode.commands.executeCommand('fakl.mesa.open');
      await vscode.commands.executeCommand('fakl.cafe.open');
      await this.save(withStep(this.progress, 'feitas', 'tour'));
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t(
          'Could not start the first task: {0}',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}
