import { homedir } from 'node:os';

import { CoreClient, coreInfoPath, readCoreInfo, type CoreInfo } from '@fakl/core';
import { l10n, useLocale } from '@fakl/i18n';
import {
  CoreNotifications,
  type AgentTerminalLinesParams,
  type TerminalHostCommand,
  type EventNotificationParams,
} from '@fakl/protocol';
import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';

import { AgentControl, AgentEventRouter } from './agents.js';
import { AiResourcesView } from './ai-resources.js';
import { ResourceSourcesView } from './resource-sources.js';
import { registerAudit } from './audit.js';
import { CafeUi } from './cafe.js';
import { CiUi } from './ci.js';
import { ExternalSessionsFeed } from './externas.js';
import { ChatViewProvider } from './chat.js';
import { OverlayControl } from './overlay.js';
import { addCliToSystemPath, installCli } from './cli.js';
import { CostsView } from './costs.js';
import { EconomiaView } from './economia.js';
import { ScorecardView } from './scorecard.js';
import { EmailUi } from './email.js';
import { GitHubUi } from './github.js';
import { GitHubAuth } from './github-auth.js';
import { HostingerUi } from './hostinger.js';
import { ProvidersUi } from './providers.js';
import { LovableUi } from './lovable.js';
import { McpLibraryView } from './mcp-library-view.js';
import { McpResourcesView } from './mcp-resources.js';
import { registerWindowCommands } from './janelas.js';
import { MesaUi } from './mesa.js';
import { ClaudeAccountsUi } from './claude-accounts.js';
import { ProfilesView } from './profiles.js';
import { RemoteUi } from './remote.js';
import { DoctorUi } from './doctor.js';
import { SetupUi } from './setup.js';
import { SshUi } from './ssh.js';
import { TourUi } from './tour.js';
import { TasksView } from './tasks.js';
import { focusMesa, offerTheme } from './theme.js';
import { VaultUi } from './vault.js';
import { VaultGraphUi } from './vault-graph.js';
import { vaultMarkdown } from './vault-markdown.js';
import { VozUi } from './voz.js';
import { OfficialExtensionsNotice } from './official-extensions.js';
import { UpdateNoticeUi } from './update-notice.js';
import { UsageWindowsView } from './windows.js';

const RETRY_MS = 2_000;
const MAX_ATTEMPTS = 15;

interface Connection {
  client: CoreClient;
  info: CoreInfo;
}

/** O que a extensão entrega ao VS Code: o plugin da prévia de Markdown. */
export interface FaklCoreApi {
  extendMarkdownIt(md: MarkdownIt): MarkdownIt;
}

export function activate(context: vscode.ExtensionContext): FaklCoreApi {
  // Textos em inglês no código; o pt-BR vem do @fakl/i18n quando a IDE está em português.
  useLocale(vscode.env.language);
  const output = vscode.window.createOutputChannel('FaKL Core', { log: true });
  const item = vscode.window.createStatusBarItem('fakl.core', vscode.StatusBarAlignment.Left, 100);
  item.name = 'FaKL Core';
  item.command = 'fakl.core.status';
  context.subscriptions.push(output, item);

  // Quem já usava a IDE antes da jornada de configuração existir não a vê abrir
  // sozinha; lido antes de qualquer parte marcar a primeira abertura.
  const existingUser =
    context.globalState.get('fakl.chat.mostrado') !== undefined ||
    context.globalState.get('fakl.tema.oferecido') !== undefined;
  const agentEvents = new AgentEventRouter();
  let connection: Connection | undefined;
  const agents = new AgentControl(
    async () => (connection ?? (await connect()))?.client,
    agentEvents,
  );
  // A voz executa pedidos como tarefa (TasksView) ou no chat; o chat e a Mesa
  // usam a voz para o microfone. A extensão liga os dois depois de criá-los.
  const tasks = new TasksView(agentEvents);
  const voz = new VozUi(context, agents, tasks, agentEvents);
  const chat = new ChatViewProvider(context.extensionUri, agents, agentEvents, voz);
  voz.chat = chat;
  // A barra lateral secundária abre na primeira vez sem nenhum painel ativo
  // (o do chat embutido não existe aqui) e o chat parecia vazio. Mostra o
  // nosso uma vez; depois a IDE lembra.
  if (!context.globalState.get<boolean>('fakl.chat.mostrado')) {
    void vscode.commands
      .executeCommand('workbench.view.extension.fakl-chat')
      .then(() => context.globalState.update('fakl.chat.mostrado', true));
  }
  const profiles = new ProfilesView(agentEvents);
  const resourceSources = new ResourceSourcesView();
  const aiResources = new AiResourcesView(resourceSources);
  const mcpResources = new McpResourcesView();
  const mcpLibrary = new McpLibraryView(context, resourceSources);
  const costs = new CostsView(agentEvents);
  const scorecard = new ScorecardView(agentEvents, context.globalState);
  const economia = new EconomiaView(agentEvents);
  const overlay = new OverlayControl(
    async () => (connection ?? (await connect()))?.client,
    agentEvents,
  );
  const windows = new UsageWindowsView(agentEvents);
  const vault = new VaultUi(agentEvents);
  const vaultGraph = new VaultGraphUi(context.extensionUri, () => vault.root, agentEvents);
  const remote = new RemoteUi(context, agentEvents);
  const externas = new ExternalSessionsFeed();
  const cafe = new CafeUi(context.extensionUri, agentEvents, agents, externas);
  const ci = new CiUi(agentEvents);
  const mesa = new MesaUi(context, agents, agentEvents, voz, externas);
  const githubAuth = new GitHubAuth(context);
  const github = new GitHubUi(githubAuth, context.extensionUri);
  const email = new EmailUi(context);
  const ssh = new SshUi();
  const hostinger = new HostingerUi(context, () => void ssh.reload());
  const providers = new ProvidersUi(context);
  const lovable = new LovableUi(github);
  const claudeAccounts = new ClaudeAccountsUi(context, agentEvents);
  const setup = new SetupUi(context);
  const doctor = new DoctorUi();
  const tour = new TourUi(context, agents);
  agents.onStartFailure = (profileId, error) => {
    void doctor.offerAfterFailure(profileId, error);
  };
  const updateNotice = new UpdateNoticeUi(context);
  const officialExtensions = new OfficialExtensionsNotice(context);
  agents.pickClaudeAccount = (profileId) => claudeAccounts.pickForNewAgent(profileId);
  // Partes da IDE que falam com o Core: avisadas quando a conexão abre e cai.
  const coreParts = [
    agents,
    profiles,
    resourceSources,
    aiResources,
    mcpLibrary,
    costs,
    scorecard,
    economia,
    tasks,
    vault,
    vaultGraph,
    remote,
    cafe,
    ci,
    mesa,
    externas,
    chat,
    githubAuth,
    github,
    email,
    ssh,
    hostinger,
    providers,
    lovable,
    claudeAccounts,
    windows,
    overlay,
    voz,
    setup,
    doctor,
  ];
  context.subscriptions.push(
    windows,
    windows.register(),
    registerWindowCommands(),
    voz,
    mesa,
    cafe,
    ci,
    externas,
    vaultGraph,
    githubAuth,
    github,
    email,
    ssh,
    hostinger,
    providers,
    lovable,
    claudeAccounts,
    registerAudit(() => connection?.client),
    agents,
    chat,
    profiles,
    resourceSources,
    aiResources,
    mcpResources,
    mcpLibrary,
    costs,
    scorecard,
    economia,
    overlay,
    tasks,
    vault,
    remote,
    setup,
    doctor,
    tour,
    updateNotice,
    officialExtensions,
    profiles.onDidChangeProfiles(() => {
      chat.refreshProfiles();
    }),
  );
  let connecting: Promise<Connection | undefined> | undefined;
  let disposed = false;

  const show = (state: 'connecting' | 'online' | 'offline'): void => {
    if (state === 'online') {
      item.text = '$(pulse) FaKL Core';
      item.tooltip = l10n.t('FaKL Core running');
      item.backgroundColor = undefined;
    } else if (state === 'connecting') {
      item.text = '$(sync~spin) FaKL Core';
      item.tooltip = l10n.t('Connecting to the FaKL Core');
      item.backgroundColor = undefined;
    } else {
      item.text = '$(debug-disconnect) FaKL Core';
      item.tooltip = l10n.t('FaKL Core is down. Click to try again.');
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    item.show();
  };

  const tryConnect = async (): Promise<Connection | undefined> => {
    const info = await readCoreInfo(coreInfoPath(homedir()));
    if (!info) return undefined;
    const client = await CoreClient.connect(info.socketPath, info.token, 'extension', {
      locale: vscode.env.language,
    });
    client.onNotification((method, params) => {
      if (method === CoreNotifications.event) {
        agentEvents.dispatch((params as EventNotificationParams).event);
      } else if (method === CoreNotifications.terminalLines) {
        agentEvents.dispatchTerminal(params as AgentTerminalLinesParams);
      } else if (method === CoreNotifications.terminalHost) {
        agentEvents.dispatchHost(params as TerminalHostCommand);
      }
    });
    await client.request('events.subscribe', {
      topics: [
        'agent.*',
        'cost.update',
        'config.changed',
        'run.*',
        'vault.*',
        'remote.*',
        'claude.*',
        'ci.*',
        'ui.reveal',
      ],
    });
    return { client, info };
  };

  const connect = (): Promise<Connection | undefined> => {
    connecting ??= (async () => {
      show('connecting');
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !disposed; attempt++) {
        try {
          const result = await tryConnect();
          if (result) {
            connection = result;
            // Se o Core cair, o processo principal o reinicia (RNF-06) e a extensão
            // reconecta sozinha; sem sucesso, a barra mostra e o clique tenta de novo.
            result.client.onClose(() => {
              if (disposed || connection !== result) return;
              connection = undefined;
              for (const part of coreParts) part.disconnected();
              output.warn(l10n.t('connection to the Core closed; reconnecting'));
              show('offline');
              setTimeout(() => {
                if (!disposed && !connection) void connect();
              }, RETRY_MS);
            });
            output.info(
              l10n.t(
                'connected to Core {0} (pid {1}) at {2}',
                result.client.hello.coreVersion,
                result.info.pid,
                result.info.socketPath,
              ),
            );
            show('online');
            for (const part of coreParts) part.connected(result.client);
            return result;
          }
          output.info(l10n.t('attempt {0}: Core has not published core.json yet', attempt));
        } catch (error) {
          output.info(l10n.t('attempt {0}: {1}', attempt, String(error)));
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
      output.warn(l10n.t('could not connect to the Core'));
      show('offline');
      return undefined;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fakl.cli.addToPath', () => addCliToSystemPath()),
    vscode.commands.registerCommand('fakl.mesa.focus', () => focusMesa()),
    vscode.commands.registerCommand('fakl.core.status', async () => {
      const current = connection ?? (await connect());
      if (!current) {
        const choice = await vscode.window.showWarningMessage(
          l10n.t(
            'The FaKL Core is not responding. It starts with the IDE; reopening the IDE usually fixes it.',
          ),
          l10n.t('View log'),
        );
        if (choice) output.show();
        return;
      }
      const { coreVersion, pid } = current.client.hello;
      void vscode.window.showInformationMessage(
        l10n.t(
          'FaKL Core {0} running (pid {1}), API at {2}.',
          coreVersion,
          pid,
          current.info.socketPath,
        ),
      );
    }),
    {
      dispose: () => {
        disposed = true;
        connection?.client.close();
      },
    },
  );

  void connect();
  updateNotice.start();
  officialExtensions.start();
  mesa.openOnStartup();
  // Por último, para a jornada ficar na frente na primeira abertura.
  setup.openOnFirstRun(existingUser);
  offerTheme(context).catch((error: unknown) => {
    output.warn(l10n.t('could not offer the theme: {0}', String(error)));
  });
  installCli(context).catch((error: unknown) => {
    output.warn(l10n.t('could not install the fakl CLI: {0}', String(error)));
  });
  return {
    extendMarkdownIt: (md) =>
      vaultMarkdown(md, (target, env) => vault.resolveLink(target, env), {
        read: (target) => vault.readNote(target),
        currentKey: (env) => vault.currentNoteKey(env),
      }),
  };
}

export function deactivate(): void {
  // Os recursos são liberados por context.subscriptions.
}
