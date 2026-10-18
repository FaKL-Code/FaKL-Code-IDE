import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import { mayCheckUpdateNotice } from './rede-model.js';
import { readNetworkSettings } from './rede.js';
import {
  decideNotice,
  parseUpdateNotice,
  UPDATE_NOTICE_URL,
  type UpdateNotice,
} from './update-model.js';

const LAST_NOTIFIED = 'fakl.atualizacao.avisada';
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 12 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Padrão do `update.minReleaseAge` na FaKL-Code, em horas (ADR 0037). */
const DEFAULT_MIN_AGE_HOURS = 24;

/**
 * Avisa de versão nova da IDE onde o VS Code não se atualiza sozinho, o macOS: a
 * assinatura ad hoc não passa no atualizador nativo (ADR 0037). No Windows o
 * serviço nativo cuida de tudo, e aqui só o comando manual responde.
 */
export class UpdateNoticeUi implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.commands.registerCommand('fakl.update.check', () => this.check(true)),
    );
  }

  /** Liga a verificação periódica, se este sistema precisa dela e o usuário não a desligou. */
  start(): void {
    if (process.platform !== 'darwin') return;
    this.timer = setTimeout(() => void this.loop(), FIRST_CHECK_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const item of this.subscriptions) item.dispose();
  }

  private async loop(): Promise<void> {
    await this.check(false).catch(() => undefined);
    this.timer = setTimeout(() => void this.loop(), CHECK_EVERY_MS);
  }

  /** A busca automática depende do interruptor geral (`fakl.rede.consultasAutomaticas`). */
  private enabled(): boolean {
    return mayCheckUpdateNotice(readNetworkSettings());
  }

  private async fetchNotice(): Promise<UpdateNotice | undefined> {
    const response = await fetch(UPDATE_NOTICE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseUpdateNotice(await response.json());
  }

  /** `explicit`: o usuário pediu, então responde mesmo quando não há nada novo. */
  async check(explicit: boolean): Promise<void> {
    if (!explicit && !this.enabled()) return;
    let notice: UpdateNotice | undefined;
    try {
      notice = await this.fetchNotice();
    } catch (error) {
      if (explicit) {
        void vscode.window.showWarningMessage(
          l10n.t('Could not check for updates: {0}', String(error)),
        );
      }
      return;
    }
    if (!notice) {
      if (explicit) {
        void vscode.window.showWarningMessage(l10n.t('Could not read the update information.'));
      }
      return;
    }
    const minAge = vscode.workspace
      .getConfiguration('update')
      .get<number>('minReleaseAge', DEFAULT_MIN_AGE_HOURS);
    const decision = decideNotice(notice, {
      currentVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      now: Date.now(),
      minReleaseAgeHours: explicit ? 0 : minAge,
      lastNotified: explicit ? undefined : this.context.globalState.get<string>(LAST_NOTIFIED),
    });
    if (!decision.show) {
      if (explicit) {
        void vscode.window.showInformationMessage(
          decision.reason === 'no-build'
            ? l10n.t('There is no FaKL-Code build for this system in the latest release.')
            : l10n.t('FaKL-Code is up to date.'),
        );
      }
      return;
    }
    await this.context.globalState.update(LAST_NOTIFIED, decision.tag);
    const download = l10n.t('Download');
    const choice = await vscode.window.showInformationMessage(
      l10n.t('FaKL-Code {0} is available.', decision.tag.slice(1)),
      download,
      l10n.t('Later'),
    );
    if (choice === download) await vscode.env.openExternal(vscode.Uri.parse(decision.page));
  }
}
