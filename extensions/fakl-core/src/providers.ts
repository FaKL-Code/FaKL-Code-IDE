import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import {
  apiKeySecretName,
  isProviderId,
  type AgentProfileDefinition,
  type ProvidersDetectParams,
  type ProvidersDetectResult,
  type ProvidersGenerateResult,
  type ProviderStatus,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import {
  fixCommands,
  keyTargets,
  parseArgs,
  outdated,
  parseEnvPairs,
  statusLine,
  type KeyTarget,
} from './providers-model.js';

/** Ids dos provedores com chave guardada; os valores ficam só no SecretStorage. */
const KEY_LIST = 'fakl.apikeys';
const storedKey = (id: string): string => `fakl.apikey.${id}`;

/** Agentes ACP que a IDE já sabe cadastrar (os mesmos de `ACP_AGENT_PRESETS` no Core). */
const ACP_PRESETS = [
  { id: 'opencode', nome: 'OpenCode', comando: 'opencode', args: 'acp' },
  { id: 'qwen', nome: 'Qwen Code', comando: 'qwen', args: '--acp' },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Provedores de IA (ADR 0035): chaves de API no cofre do sistema, agentes ACP
 * cadastrados e a lista do que está pronto. A chave vai ao Core a cada
 * conexão e de lá só ao processo do agente daquele provedor; nunca é logada
 * nem gravada em arquivo.
 */
export class ProvidersUi implements vscode.Disposable {
  private client: CoreClient | undefined;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables = [
      vscode.commands.registerCommand('fakl.providers.detect', () => this.showProviders()),
      vscode.commands.registerCommand('fakl.providers.setKey', (id?: string) => this.setKey(id)),
      vscode.commands.registerCommand('fakl.providers.removeKey', () => this.removeKey()),
      vscode.commands.registerCommand('fakl.providers.addAcp', () => this.addAcp()),
    ];
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.pushAll().then(() => this.generate());
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private get keyIds(): string[] {
    return this.context.globalState.get<string[]>(KEY_LIST, []).filter(isProviderId);
  }

  private async setKeyIds(ids: readonly string[]): Promise<void> {
    await this.context.globalState.update(KEY_LIST, [...new Set(ids)].sort());
  }

  private async push(id: string): Promise<void> {
    const value = await this.context.secrets.get(storedKey(id));
    await this.client
      ?.request('secrets.set', { nome: apiKeySecretName(id), valor: value ?? null })
      .catch(() => undefined);
  }

  private async pushAll(): Promise<void> {
    for (const id of this.keyIds) await this.push(id);
  }

  /** Perfis para os provedores que ficaram prontos; com `ids`, mesmo os que já tiveram antes. */
  private async generate(ids?: readonly string[]): Promise<readonly string[]> {
    const result = await this.client
      ?.request<ProvidersGenerateResult>(
        'providers.generateProfiles',
        ids ? { provedores: ids } : {},
      )
      .catch(() => undefined);
    return result?.criados ?? [];
  }

  private async detect(): Promise<ProviderStatus[] | undefined> {
    if (!this.client) {
      void vscode.window.showErrorMessage(l10n.t('The FaKL Core is not responding.'));
      return undefined;
    }
    try {
      // A consulta ao npm (versão mais nova dos adaptadores) é desligável.
      const params: ProvidersDetectParams = {
        atualizacoes: vscode.workspace
          .getConfiguration('fakl')
          .get<boolean>('providers.checkUpdates', true),
      };
      return [
        ...(await this.client.request<ProvidersDetectResult>('providers.detect', params))
          .provedores,
      ];
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not detect the providers: {0}', message(error)),
      );
      return undefined;
    }
  }

  private async showProviders(): Promise<void> {
    const statuses = await this.detect();
    if (!statuses) return;
    const ready = statuses.filter((status) => status.pronto).length;
    type Item = vscode.QuickPickItem & { status?: ProviderStatus; action?: 'key' | 'acp' };
    const items: Item[] = [
      ...statuses.map((status) => ({ ...statusLine(status), status })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: l10n.t('$(key) Set API key…'), action: 'key' },
      { label: l10n.t('$(add) Add ACP agent…'), action: 'acp' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title:
        ready === 1 ? l10n.t('AI providers: 1 ready') : l10n.t('AI providers: {0} ready', ready),
      placeHolder:
        ready === 0
          ? l10n.t('No provider ready: the IDE works without AI. Pick one to see what is missing.')
          : l10n.t('Pick a provider to see what is missing or to use an API key'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.action === 'key') return this.setKey();
    if (picked.action === 'acp') return this.addAcp();
    if (picked.status) await this.fix(picked.status);
  }

  /** Oferece os comandos que faltam num terminal (sem rodar: o usuário confere e aperta Enter). */
  private async fix(status: ProviderStatus): Promise<void> {
    const commands = fixCommands(status);
    const updates = outdated(status);
    const options = [
      ...updates.map((item) => ({
        label: l10n.t(
          '$(cloud-download) Update {0} ({1} → {2})',
          item.comando,
          item.instalada,
          item.ultima,
        ),
        command: '',
        update: item.atualizar,
      })),
      ...commands.map((command) => ({ label: `$(terminal) ${command}`, command, update: '' })),
      ...(status.chaveEnv && !status.chave
        ? [{ label: l10n.t('$(key) Use an API key'), command: '', update: '' }]
        : []),
    ];
    if (options.length === 0) {
      void vscode.window.showInformationMessage(
        status.pronto
          ? status.perfis.length
            ? l10n.t('{0} is ready (profiles: {1}).', status.nome, status.perfis.join(', '))
            : l10n.t('{0} is ready.', status.nome)
          : (status.aviso ?? l10n.t('{0} is not ready.', status.nome)),
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(options, {
      title: status.nome,
      placeHolder: status.aviso ?? l10n.t('What do you want to do?'),
    });
    if (!picked) return;
    if (picked.update) return this.update(status, picked.update);
    if (!picked.command) return this.setKey(status.id);
    const terminal = vscode.window.createTerminal({ name: `FaKL: ${status.nome}` });
    terminal.show();
    terminal.sendText(picked.command, false);
  }

  /** Atualiza um pacote com `npm install -g`, só depois de o usuário confirmar; a saída aparece no terminal. */
  private async update(status: ProviderStatus, command: string): Promise<void> {
    const yes = l10n.t('Update');
    const answer = await vscode.window.showWarningMessage(
      l10n.t('Run `{0}`?', command),
      {
        modal: true,
        detail: l10n.t(
          'Updates the {0} agent on this machine. Sessions already open keep the old version until they restart.',
          status.nome,
        ),
      },
      yes,
    );
    if (answer !== yes) return;
    const terminal = vscode.window.createTerminal({ name: `FaKL: ${status.nome}` });
    terminal.show();
    terminal.sendText(command, true);
  }

  private async pickTarget(
    title: string,
    targets: readonly KeyTarget[],
  ): Promise<KeyTarget | undefined> {
    const stored = new Set(this.keyIds);
    const picked = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: target.nome,
        description: target.variavel,
        ...(stored.has(target.id) ? { detail: l10n.t('a key is stored') } : {}),
        target,
      })),
      { title },
    );
    return picked?.target;
  }

  private async setKey(id?: string): Promise<void> {
    const targets = keyTargets((await this.detect()) ?? []);
    const target =
      targets.find((candidate) => candidate.id === id) ??
      (await this.pickTarget(l10n.t('API key for which provider?'), targets));
    if (!target) return;
    const value = await vscode.window.showInputBox({
      title: l10n.t('API key: {0}', target.nome),
      prompt: l10n.t(
        'Goes to the {0} agent in {1}, and only to it. Stored in the system keychain, never in a file. A stored key takes precedence over the subscription login.',
        target.nome,
        target.variavel,
      ),
      password: true,
      ignoreFocusOut: true,
      ...(target.id === 'openai'
        ? {
            placeHolder: l10n.t(
              'Codex keeps a copy in its own folder under ~/.fakl, not in ~/.codex, so your subscription login stays',
            ),
          }
        : {}),
    });
    const key = value?.trim();
    if (!key) return;
    await this.context.secrets.store(storedKey(target.id), key);
    await this.setKeyIds([...this.keyIds, target.id]);
    await this.push(target.id);
    const created = await this.generate([target.id]);
    void vscode.window.showInformationMessage(
      created.length > 0
        ? l10n.t('{0} key stored. Profiles created: {1}.', target.nome, created.join(', '))
        : l10n.t('{0} key stored.', target.nome),
    );
  }

  private async removeKey(): Promise<void> {
    const stored = new Set(this.keyIds);
    const targets = keyTargets((await this.detect()) ?? []).filter((t) => stored.has(t.id));
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('No API key stored.'));
      return;
    }
    const target = await this.pickTarget(l10n.t('Remove the API key of which provider?'), targets);
    if (!target) return;
    await this.context.secrets.delete(storedKey(target.id));
    await this.setKeyIds(this.keyIds.filter((id) => id !== target.id));
    await this.push(target.id);
    void vscode.window.showInformationMessage(
      l10n.t('{0} key removed; its agents go back to the CLI login.', target.nome),
    );
  }

  private async addAcp(): Promise<void> {
    if (!this.client) {
      void vscode.window.showErrorMessage(l10n.t('The FaKL Core is not responding.'));
      return;
    }
    const preset = await vscode.window.showQuickPick(
      [
        ...ACP_PRESETS.map((item) => ({
          label: item.nome,
          description: `${item.comando} ${item.args}`,
          item,
        })),
        { label: l10n.t('$(edit) Other ACP-compatible agent…'), item: undefined },
      ],
      { title: l10n.t('Add ACP agent') },
    );
    if (!preset) return;
    const nome =
      preset.item?.nome ??
      (await vscode.window.showInputBox({ title: l10n.t('Agent name'), ignoreFocusOut: true }));
    if (!nome) return;
    const id = await vscode.window.showInputBox({
      title: l10n.t('Provider and profile id'),
      value:
        preset.item?.id ??
        nome
          .toLowerCase()
          .normalize('NFD')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      validateInput: (text) =>
        isProviderId(text) ? undefined : l10n.t('lowercase letters, numbers and hyphens'),
      ignoreFocusOut: true,
    });
    if (!id) return;
    const comando = await vscode.window.showInputBox({
      title: l10n.t('Agent command (on the PATH or full path)'),
      value: preset.item?.comando ?? '',
      ignoreFocusOut: true,
    });
    if (!comando) return;
    const args = await vscode.window.showInputBox({
      title: l10n.t('Arguments that turn on ACP mode'),
      value: preset.item?.args ?? '',
      ignoreFocusOut: true,
    });
    if (args === undefined) return;
    const envText = await vscode.window.showInputBox({
      title: l10n.t('Extra variables (optional), no secrets'),
      prompt: l10n.t(
        'NAME=value; OTHER=value. API keys go in the next step, through the keychain.',
      ),
      validateInput: (text) => {
        const parsed = parseEnvPairs(text);
        return typeof parsed === 'string' ? parsed : undefined;
      },
      ignoreFocusOut: true,
    });
    if (envText === undefined) return;
    const chaveEnv = await vscode.window.showInputBox({
      title: l10n.t('API key variable (optional)'),
      prompt: l10n.t(
        'If the agent uses a key (e.g. OPENROUTER_API_KEY), the IDE passes it in this variable.',
      ),
      validateInput: (text) =>
        !text || /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
          ? undefined
          : l10n.t('invalid variable name'),
      ignoreFocusOut: true,
    });
    if (chaveEnv === undefined) return;
    const env = parseEnvPairs(envText);
    try {
      const profile = await this.client.request<AgentProfileDefinition>('providers.acp.add', {
        id,
        nome,
        comando,
        args: parseArgs(args),
        ...(typeof env === 'object' && Object.keys(env).length > 0 ? { env } : {}),
        ...(chaveEnv ? { chaveEnv } : {}),
      });
      const next = await vscode.window.showInformationMessage(
        l10n.t('Agent {0} added as profile {1}.', profile.nome, profile.id),
        ...(chaveEnv ? [l10n.t('Store the API key')] : []),
      );
      if (next) await this.setKey(profile.id);
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not add the agent: {0}', message(error)));
    }
  }
}
