import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { AgentProfileDefinition, AgentProfileEntry } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';

function providerChoices(): readonly { label: string; provedor: string; description: string }[] {
  return [
    { label: 'Claude Code', provedor: 'anthropic', description: 'claude-agent-acp' },
    { label: 'Codex', provedor: 'openai', description: 'codex-acp' },
    { label: 'Gemini CLI', provedor: 'google', description: 'gemini --acp' },
    {
      label: l10n.t('Other ACP agent'),
      provedor: 'outro',
      description: l10n.t('set the command in the file'),
    },
    { label: l10n.t('Local model on Ollama'), provedor: 'ollama', description: 'localhost:11434' },
    {
      label: l10n.t('Local model on LM Studio'),
      provedor: 'lmstudio',
      description: 'localhost:1234',
    },
  ];
}

const LOCAL = new Set(['ollama', 'lmstudio']);

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * Perfis de agente (RF-101): uma árvore com os arquivos de
 * `~/.fakl/profiles`. Editar é abrir o YAML; o Core relê ao salvar e avisa
 * com `config.changed`.
 */
export class ProfilesView implements vscode.TreeDataProvider<AgentProfileEntry>, vscode.Disposable {
  private entries: AgentProfileEntry[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly profilesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;

  readonly onDidChangeTreeData = this.changed.event;
  /** Um perfil foi criado, mudou ou saiu. */
  readonly onDidChangeProfiles = this.profilesChanged.event;

  constructor(router: AgentEventRouter) {
    this.disposables.push(
      this.changed,
      this.profilesChanged,
      vscode.window.createTreeView('fakl.profiles', { treeDataProvider: this }),
      router.listen((event) => {
        if (event.topic === 'config.changed') void this.reload();
      }),
      vscode.commands.registerCommand('fakl.profiles.new', () => this.create()),
      vscode.commands.registerCommand('fakl.profiles.edit', (entry?: AgentProfileEntry) =>
        this.edit(entry),
      ),
      vscode.commands.registerCommand('fakl.profiles.delete', (entry?: AgentProfileEntry) =>
        this.remove(entry),
      ),
      vscode.commands.registerCommand('fakl.profiles.refresh', () => this.reload()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(entry: AgentProfileEntry): vscode.TreeItem {
    const { profile } = entry;
    const item = new vscode.TreeItem(profile.nome);
    item.id = profile.id;
    item.description = [profile.modelo ?? profile.provedor, profile.custoRelativo]
      .filter(Boolean)
      .join(' · ');
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${profile.nome}** (\`${profile.id}\`)\n\n`);
    tooltip.appendMarkdown(
      profile.modelo
        ? l10n.t('Provider: {0} · model {1}', profile.provedor, profile.modelo)
        : l10n.t('Provider: {0}', profile.provedor),
    );
    if (profile.pontosFortes?.length) {
      tooltip.appendMarkdown('\n\n' + l10n.t('Strengths: {0}', profile.pontosFortes.join(', ')));
    }
    if (profile.podeSerMaestro) tooltip.appendMarkdown('\n\n' + l10n.t('Can be maestro.'));
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(profile.podeSerMaestro ? 'star' : 'person');
    item.contextValue = 'fakl.profile';
    item.command = {
      command: 'fakl.profiles.edit',
      title: l10n.t('Edit profile'),
      arguments: [entry],
    };
    return item;
  }

  getChildren(entry?: AgentProfileEntry): AgentProfileEntry[] {
    return entry ? [] : this.entries;
  }

  private async reload(): Promise<void> {
    if (!this.client) return;
    try {
      this.entries = await this.client.request<AgentProfileEntry[]>('profiles.list');
    } catch {
      return;
    }
    this.changed.fire(undefined);
    this.profilesChanged.fire();
  }

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  private async create(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const provider = await vscode.window.showQuickPick(providerChoices(), {
      title: l10n.t('New agent profile'),
      placeHolder: l10n.t('Which agent does this profile use?'),
    });
    if (!provider) return;
    const nome = await vscode.window.showInputBox({
      title: l10n.t('New agent profile'),
      prompt: l10n.t('Profile name, for example "Strict reviewer"'),
      validateInput: (value) =>
        slug(value) ? undefined : l10n.t('Use at least one letter or number'),
    });
    if (!nome) return;
    const taken = new Set(this.entries.map((entry) => entry.profile.id));
    let id = slug(nome);
    for (let n = 2; taken.has(id); n++) id = `${slug(nome).slice(0, 60)}-${String(n)}`;
    const profile: AgentProfileDefinition = {
      id,
      nome,
      provedor: provider.provedor,
      adaptador: LOCAL.has(provider.provedor) ? 'ollama' : 'acp',
      ...(provider.provedor === 'outro' ? { comando: 'meu-agente-acp' } : {}),
      // Modelo local: o nome do modelo como o servidor lista (ollama list).
      ...(LOCAL.has(provider.provedor) ? { modelo: 'qwen2.5-coder' } : {}),
      pontosFortes: [],
      custoRelativo: LOCAL.has(provider.provedor) ? 'baixo' : 'médio',
      regras: [],
      podeSerMaestro: false,
    };
    try {
      const saved = await client.request<AgentProfileEntry>('profiles.upsert', { profile });
      await this.reload();
      await this.edit(saved);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t(
          'Could not create the profile: {0}',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async edit(entry?: AgentProfileEntry): Promise<void> {
    const target = entry ?? (await this.pick(l10n.t('Edit which profile?')));
    if (!target) return;
    await vscode.window.showTextDocument(vscode.Uri.file(target.arquivo));
  }

  private async remove(entry?: AgentProfileEntry): Promise<void> {
    const target = entry ?? (await this.pick(l10n.t('Delete which profile?')));
    if (!target) return;
    const client = this.requireClient();
    if (!client) return;
    const remove = l10n.t('Delete');
    const choice = await vscode.window.showWarningMessage(
      l10n.t(
        'Delete the profile {0}? The file {1} will be removed.',
        target.profile.nome,
        target.arquivo,
      ),
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    await client.request('profiles.delete', { id: target.profile.id });
    await this.reload();
  }

  private async pick(title: string): Promise<AgentProfileEntry | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.entries.map((entry) => ({
        label: entry.profile.nome,
        description: entry.profile.id,
        entry,
      })),
      { title },
    );
    return picked?.entry;
  }
}
