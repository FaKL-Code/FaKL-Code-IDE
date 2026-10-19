import type { CoreClient, VaultStatus } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

/** Onde a chave da API de embeddings fica: só no cofre do sistema (ADR 0050). */
const STORED_KEY = 'fakl.vault.embeddings';

interface Preset {
  readonly label: string;
  readonly endpoint: string;
  readonly model: string;
}

const PRESETS: readonly Preset[] = [
  { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  { label: 'Voyage AI', endpoint: 'https://api.voyageai.com/v1', model: 'voyage-3' },
  { label: 'Mistral', endpoint: 'https://api.mistral.ai/v1', model: 'mistral-embed' },
];

export interface EmbeddingsHost {
  client(): CoreClient | undefined;
  status(): VaultStatus | undefined;
  reload(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Comandos da busca semântica por API de embeddings (RF-407, ADR 0050): escolher o
 * provedor, guardar e remover a chave no cofre do sistema e confirmar, com o servidor
 * e o custo aproximado à vista, que as notas podem sair da máquina.
 */
export class EmbeddingsUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: EmbeddingsHost,
  ) {
    this.disposables.push(
      vscode.commands.registerCommand('fakl.vault.embeddings.configure', () => this.configure()),
      vscode.commands.registerCommand('fakl.vault.embeddings.setKey', () => this.setKey()),
      vscode.commands.registerCommand('fakl.vault.embeddings.clearKey', () => this.clearKey()),
      vscode.commands.registerCommand('fakl.vault.embeddings.confirm', () => this.confirm()),
    );
  }

  /** Entrega a chave guardada ao Core a cada conexão (ele não grava segredos). */
  async connected(client: CoreClient): Promise<void> {
    const key = await this.context.secrets.get(STORED_KEY);
    await client
      .request('secrets.set', { nome: 'vault.embeddings', valor: key ?? null })
      .catch(() => undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async push(): Promise<void> {
    const client = this.host.client();
    if (client) await this.connected(client);
  }

  private async askKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: l10n.t('Embeddings API key'),
      prompt: l10n.t(
        'Stays in the system keychain, never in a file. It is only sent to the server you chose.',
      ),
      password: true,
      ignoreFocusOut: true,
    });
    return key?.trim() ? key.trim() : undefined;
  }

  private async setKey(): Promise<void> {
    const key = await this.askKey();
    if (!key) return;
    await this.context.secrets.store(STORED_KEY, key);
    await this.push();
    void vscode.window.showInformationMessage(l10n.t('Embeddings key saved in the keychain.'));
    await this.host.reload();
  }

  private async clearKey(): Promise<void> {
    await this.context.secrets.delete(STORED_KEY);
    await this.push();
    void vscode.window.showInformationMessage(l10n.t('Embeddings key removed from the keychain.'));
    await this.host.reload();
  }

  private async configure(): Promise<void> {
    const client = this.host.client();
    if (!client) return;
    if (!this.host.status()?.ativo) {
      void vscode.window.showInformationMessage(l10n.t('Set up the vault first.'));
      await vscode.commands.executeCommand('fakl.vault.configure');
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          id: 'ollama',
          label: '$(server) Ollama',
          detail: l10n.t('Local model; the notes stay on this machine'),
        },
        {
          id: 'lmstudio',
          label: '$(server) LM Studio',
          detail: l10n.t('Local model; the notes stay on this machine'),
        },
        {
          id: 'openai',
          label: `$(cloud) ${l10n.t('OpenAI-compatible API')}`,
          detail: l10n.t(
            'OpenAI, Voyage, Mistral, Azure or your own server. The notes leave this machine',
          ),
        },
        { id: 'off', label: `$(circle-slash) ${l10n.t('Turn off semantic search')}` },
      ],
      { title: l10n.t('Semantic search: embeddings provider') },
    );
    if (!choice) return;
    try {
      if (choice.id === 'off') {
        await client.request('vault.configureSemantic', { provedor: null });
      } else if (choice.id === 'openai') {
        if (!(await this.configureRemote(client))) return;
      } else {
        const modelo = await vscode.window.showInputBox({
          title: l10n.t('Embeddings model'),
          value: 'nomic-embed-text',
          ignoreFocusOut: true,
        });
        if (!modelo) return;
        await client.request('vault.configureSemantic', { provedor: choice.id, modelo });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not set up semantic search: {0}', message(error)),
      );
      return;
    }
    await this.host.reload();
    if (this.host.status()?.semantica?.aguardaConfirmacao) await this.confirm();
  }

  /** Pede servidor, modelo e chave; devolve falso se a pessoa desistiu no meio. */
  private async configureRemote(client: CoreClient): Promise<boolean> {
    const pick = await vscode.window.showQuickPick(
      [
        ...PRESETS.map((p) => ({ label: p.label, preset: p })),
        { label: l10n.t('Other (Azure or your own server)'), preset: undefined },
      ],
      { title: l10n.t('Embeddings API') },
    );
    if (!pick) return false;
    const endpoint = await vscode.window.showInputBox({
      title: l10n.t('Embeddings API endpoint'),
      prompt: l10n.t('Base address; the IDE calls <endpoint>/embeddings'),
      value: pick.preset?.endpoint ?? 'https://',
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^https?:\/\/[^/\s]+/.test(value.trim())
          ? undefined
          : l10n.t('Must start with https:// (or http://)'),
    });
    if (!endpoint) return false;
    const modelo = await vscode.window.showInputBox({
      title: l10n.t('Embeddings model'),
      value: pick.preset?.model ?? '',
      ignoreFocusOut: true,
    });
    if (!modelo) return false;
    if (!(await this.context.secrets.get(STORED_KEY))) {
      const key = await this.askKey();
      if (!key) return false;
      await this.context.secrets.store(STORED_KEY, key);
      await this.push();
    }
    // Sem `confirmar`: a configuração fica salva, mas nada sai antes do aviso.
    await client.request('vault.configureSemantic', {
      provedor: 'openai',
      modelo,
      endpoint: endpoint.trim(),
    });
    return true;
  }

  /** Aviso de privacidade e custo; só o "sim" libera o envio das notas. */
  private async confirm(): Promise<void> {
    const client = this.host.client();
    await this.host.reload();
    const semantica = this.host.status()?.semantica;
    if (!client || !semantica?.remota || !semantica.servidor) return;
    const estimativa = semantica.estimativa;
    const sendLabel = l10n.t('Send the notes to {0}', semantica.servidor);
    const answer = await vscode.window.showWarningMessage(
      l10n.t('Semantic search will send your notes to {0}', semantica.servidor),
      {
        modal: true,
        detail: [
          l10n.t(
            'The text of your public notes leaves this machine and is processed by that server, under its terms. Private notes are never sent.',
          ),
          estimativa
            ? l10n.t(
                'About {0} notes, {1} excerpts and {2} tokens to index now; check the price of model {3} with your provider.',
                String(estimativa.notas),
                String(estimativa.trechos),
                String(estimativa.tokens),
                semantica.modelo ?? '',
              )
            : '',
          l10n.t('If you change the server, this is asked again.'),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      sendLabel,
    );
    if (answer !== sendLabel) {
      void vscode.window.showInformationMessage(
        l10n.t('Nothing was sent. Semantic search stays paused until you confirm.'),
      );
      return;
    }
    try {
      await client.request('vault.configureSemantic', {
        provedor: 'openai',
        modelo: semantica.modelo,
        endpoint: semantica.endpoint,
        confirmar: true,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not set up semantic search: {0}', message(error)),
      );
      return;
    }
    await this.host.reload();
  }
}
