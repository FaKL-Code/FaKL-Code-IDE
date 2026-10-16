/**
 * Extensão embutida da FaKL-Code para RF-004 (importar do VS Code) e RF-005
 * (sincronizar entre máquinas). A lógica fica em @fakl/settings-sync; aqui só
 * há a interface com a IDE.
 */
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { currentLocale, l10n, useLocale } from '@fakl/i18n';
import {
  currentPlatformEnv,
  detectEditors,
  editorLocations,
  githubTokenEnv,
  importFromEditor,
  missingExtensions,
  normalizeExtensionId,
  SettingsSync,
  systemGit,
  type EditorLocation,
  type ExtensionId,
} from '@fakl/settings-sync';
import * as vscode from 'vscode';

import { cloneUrl, GitHubApi, parseRepository } from './github.js';

const IMPORT_OFFERED = 'fakl.import.offered';
const CONFIG = 'fakl.sync';

let output: vscode.LogOutputChannel;
let statusItem: vscode.StatusBarItem;
let syncing: Promise<void> | undefined;

/** Pasta `User` da FaKL-Code, deduzida do armazenamento global da extensão. */
function userDir(context: vscode.ExtensionContext): string {
  return dirname(dirname(context.globalStorageUri.fsPath));
}

function faklDir(): string {
  return join(homedir(), '.fakl');
}

function installedExtensions(): ExtensionId[] {
  return vscode.extensions.all
    .filter((extension) => !(extension.packageJSON as { isBuiltin?: boolean }).isBuiltin)
    .map((extension) => normalizeExtensionId(extension.id));
}

/** Instala extensões do Open VSX e devolve as que não foram encontradas. */
async function installExtensions(ids: readonly ExtensionId[]): Promise<ExtensionId[]> {
  const failed: ExtensionId[] = [];
  if (ids.length === 0) return failed;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: l10n.t('Installing extensions'),
      cancellable: false,
    },
    async (progress) => {
      for (const [index, id] of ids.entries()) {
        progress.report({
          message: `${id} (${index + 1}/${ids.length})`,
          increment: 100 / ids.length,
        });
        try {
          await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
        } catch (error) {
          output.warn(l10n.t('Extension {0} not installed: {1}', id, String(error)));
          failed.push(id);
        }
      }
    },
  );
  return failed;
}

async function pickEditor(editors: readonly EditorLocation[]): Promise<EditorLocation | undefined> {
  if (editors.length === 1) return editors[0];
  const picked = await vscode.window.showQuickPick(
    editors.map((editor) => ({ label: editor.label, description: editor.userDir, editor })),
    { title: l10n.t('Which editor do you want to import from?') },
  );
  return picked?.editor;
}

async function runImport(context: vscode.ExtensionContext): Promise<void> {
  const editors = await detectEditors(editorLocations(currentPlatformEnv()));
  if (editors.length === 0) {
    void vscode.window.showInformationMessage(
      l10n.t('No VS Code or VSCodium installation was found.'),
    );
    return;
  }
  const source = await pickEditor(editors);
  if (!source) return;

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: l10n.t('Merge'),
        description: l10n.t('Keeps what you already changed in FaKL-Code'),
        overwrite: false,
      },
      {
        label: l10n.t('Replace'),
        description: l10n.t('Values from {0} win', source.label),
        overwrite: true,
      },
    ],
    { title: l10n.t('Import from {0}', source.label) },
  );
  if (!mode) return;

  try {
    const result = await importFromEditor(source, userDir(context), { overwrite: mode.overwrite });
    output.info(l10n.t('Imported from {0}: {1}', source.label, JSON.stringify(result)));
    const toInstall = missingExtensions(installedExtensions(), result.extensions);
    const failed = await installExtensions(toInstall);

    const summary = l10n.t(
      'Imported from {0}: {1} settings, {2} keybindings, {3} snippets, {4} extensions.',
      source.label,
      result.settingsApplied.length,
      result.keybindingsAdded,
      result.snippetsCopied.length,
      toInstall.length - failed.length,
    );
    const missing =
      failed.length > 0 ? ` ${l10n.t('Not on Open VSX: {0}.', failed.join(', '))}` : '';
    const action = await vscode.window.showInformationMessage(
      `${summary}${missing}`,
      l10n.t('Reload window'),
    );
    if (action) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    output.error(error instanceof Error ? error : String(error));
    void vscode.window.showErrorMessage(l10n.t('Import failed: {0}', String(error)));
  }
}

async function offerImportOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(IMPORT_OFFERED)) return;
  // Com a jornada de configuração da fakl-core, a importação é uma etapa dela.
  if (vscode.extensions.getExtension('fakl.fakl-core')) {
    await context.globalState.update(IMPORT_OFFERED, true);
    return;
  }
  const editors = await detectEditors(editorLocations(currentPlatformEnv()));
  await context.globalState.update(IMPORT_OFFERED, true);
  if (editors.length === 0) return;
  const importar = l10n.t('Import');
  const answer = await vscode.window.showInformationMessage(
    l10n.t('Import settings, keybindings and extensions from {0}?', editors[0]?.label ?? 'VS Code'),
    importar,
    l10n.t('Not now'),
  );
  if (answer === importar) await runImport(context);
}

/** Os mesmos escopos do login da extensão fakl-core, para um login só (RF-501). */
const GITHUB_SCOPES = ['repo', 'workflow', 'notifications', 'read:org'];

async function githubToken(createIfNone: boolean): Promise<string | undefined> {
  const session =
    (await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true })) ??
    (await vscode.authentication.getSession('github', ['repo'], { silent: true })) ??
    (createIfNone
      ? await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true })
      : undefined);
  return session?.accessToken;
}

function setStatus(text: string, tooltip: string): void {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.show();
}

async function syncNow(context: vscode.ExtensionContext, interactive: boolean): Promise<void> {
  if (syncing) return syncing;
  const config = vscode.workspace.getConfiguration(CONFIG);
  const repo = parseRepository(config.get<string>('repository', ''));
  if (!repo) {
    statusItem.hide();
    if (interactive) await vscode.commands.executeCommand('fakl.sync.configure');
    return;
  }

  syncing = (async () => {
    setStatus('$(sync~spin) FaKL', l10n.t('Syncing settings'));
    try {
      const token = await githubToken(interactive);
      if (!token) {
        setStatus('$(warning) FaKL', l10n.t('Sign in to GitHub to sync'));
        return;
      }
      const sync = new SettingsSync(
        { userDir: userDir(context), faklDir: faklDir(), repoDir: join(faklDir(), 'sync', 'repo') },
        systemGit([], githubTokenEnv(token)),
      );
      const result = await sync.sync({
        remoteUrl: cloneUrl(repo),
        ignoredSettings: config.get<string[]>('ignoredSettings', []),
        installedExtensions: installedExtensions(),
        machine: hostname(),
      });
      output.info(`Sync: ${JSON.stringify(result)}`);
      const failed = await installExtensions(result.extensionsToInstall);
      if (failed.length > 0)
        output.warn(l10n.t('Extensions not installed: {0}', failed.join(', ')));

      const when = new Date().toLocaleTimeString(currentLocale());
      setStatus(
        '$(check) FaKL',
        l10n.t('Settings synced with {0} at {1}', `${repo.owner}/${repo.name}`, when),
      );
      if (interactive) {
        const changed = result.updatedLocal.length;
        void vscode.window.showInformationMessage(
          changed === 0
            ? l10n.t('Synced, nothing new.')
            : changed === 1
              ? l10n.t('Synced: 1 file updated.')
              : l10n.t('Synced: {0} files updated.', changed),
        );
      }
    } catch (error) {
      output.error(error instanceof Error ? error : String(error));
      setStatus('$(error) FaKL', l10n.t('Sync failed; see the "{0}" log', output.name));
      if (interactive)
        void vscode.window.showErrorMessage(l10n.t('Sync failed: {0}', String(error)));
    }
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}

async function configure(context: vscode.ExtensionContext): Promise<void> {
  const token = await githubToken(true);
  if (!token) return;
  const api = new GitHubApi(token);
  const login = await api.login();
  const current = vscode.workspace.getConfiguration(CONFIG).get<string>('repository', '');

  const input = await vscode.window.showInputBox({
    title: l10n.t('Private repository to sync your settings'),
    prompt: l10n.t("owner/name on GitHub. If it doesn't exist, it will be created as private."),
    value: current || `${login}/fakl-settings`,
    validateInput: (value) =>
      parseRepository(value) ? undefined : l10n.t('Use the owner/name format'),
  });
  const repo = input ? parseRepository(input) : undefined;
  if (!repo) return;

  const visibility = await api.repositoryVisibility(repo);
  if (!visibility) {
    if (repo.owner.toLowerCase() !== login.toLowerCase()) {
      void vscode.window.showErrorMessage(
        l10n.t("{0} doesn't exist or you don't have access.", `${repo.owner}/${repo.name}`),
      );
      return;
    }
    await api.createPrivateRepository(repo.name);
  } else if (!visibility.private) {
    const usar = l10n.t('Use anyway');
    const answer = await vscode.window.showWarningMessage(
      l10n.t(
        '{0} is public: your settings would be visible to anyone.',
        `${repo.owner}/${repo.name}`,
      ),
      { modal: true },
      usar,
    );
    if (answer !== usar) return;
  }

  await vscode.workspace
    .getConfiguration(CONFIG)
    .update('repository', `${repo.owner}/${repo.name}`, vscode.ConfigurationTarget.Global);
  await syncNow(context, true);
}

export function activate(context: vscode.ExtensionContext): void {
  // Textos em inglês no código; o pt-BR vem do @fakl/i18n quando a IDE está em português.
  useLocale(vscode.env.language);
  output = vscode.window.createOutputChannel(l10n.t('FaKL: Sync'), { log: true });
  statusItem = vscode.window.createStatusBarItem('fakl.sync', vscode.StatusBarAlignment.Left, 0);
  statusItem.name = l10n.t('FaKL: Sync');
  statusItem.command = 'fakl.sync.now';

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('fakl.settings.import', () => runImport(context)),
    vscode.commands.registerCommand('fakl.sync.configure', () => configure(context)),
    vscode.commands.registerCommand('fakl.sync.now', () => syncNow(context, true)),
    vscode.commands.registerCommand('fakl.sync.disable', async () => {
      await vscode.workspace
        .getConfiguration(CONFIG)
        .update('repository', '', vscode.ConfigurationTarget.Global);
      statusItem.hide();
    }),
  );

  // Sincroniza logo depois de uma mudança de settings, sem disparar a cada tecla.
  let debounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void syncNow(context, false), 30_000);
    }),
    {
      dispose: () => {
        clearTimeout(debounce);
      },
    },
  );

  const minutes = Math.max(
    1,
    vscode.workspace.getConfiguration(CONFIG).get<number>('intervalMinutes', 5),
  );
  const timer = setInterval(() => void syncNow(context, false), minutes * 60_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
    },
  });

  void offerImportOnce(context).then(() => syncNow(context, false));
}

export function deactivate(): Promise<void> | undefined {
  return syncing;
}
