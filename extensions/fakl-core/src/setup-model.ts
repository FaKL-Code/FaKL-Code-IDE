/**
 * Jornada de configuração: as etapas, o que conta como feito em cada uma e os
 * botões que ela mostra. Funções puras, sem VS Code: o host junta o retrato
 * da máquina ({@link SetupSnapshot}) e o progresso guardado, e daqui sai a
 * tela inteira. Nenhuma etapa é obrigatória; a IDE funciona sem IA.
 *
 * Os textos ficam em inglês em `l10n.t` e o pt-BR vem do catálogo `jornada`
 * do @fakl/i18n; por isso as etapas são montadas a cada chamada, depois de
 * `useLocale`, e não numa constante do módulo.
 */

import { l10n } from '@fakl/i18n';
import {
  providerName,
  type DailyCap,
  type PermissionPolicyName,
  type ProviderStatus,
} from '@fakl/protocol';

import { statusLine } from './providers-model.js';
import {
  SETUP_STEP_IDS,
  type ProviderActionId,
  type SetupAction,
  type SetupCap,
  type SetupGroup,
  type SetupPermissionOption,
  type SetupProviderRow,
  type SetupStepId,
  type SetupStepState,
  type SetupStepView,
  type SetupView,
} from './setup-protocol.js';

/** Chave do globalState onde fica o {@link SetupProgress}; o tour guarda as dicas vistas no mesmo lugar. */
export const SETUP_PROGRESS_KEY = 'fakl.setup.progresso';

export const THEME_NAME = 'FaKL Noite';

/** Nome de cada idioma no próprio idioma, como o VS Code mostra na troca. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  'pt-br': 'Português (Brasil)',
};

export function languageName(locale: string): string {
  return LANGUAGE_NAMES[locale.toLowerCase()] ?? locale;
}

/** O que a jornada sabe da máquina agora; `undefined` é "não deu para saber". */
export interface SetupSnapshot {
  readonly conectado: boolean;
  /** Idioma da interface (`vscode.env.language`). */
  readonly idioma?: string;
  readonly tema?: string;
  readonly provedores?: readonly ProviderStatus[];
  readonly permissoes?: PermissionPolicyName;
  readonly tetos?: Readonly<Record<string, DailyCap>>;
  readonly github?: { readonly conectado: boolean; readonly usuario?: string };
  readonly fontes?: number;
  readonly vault?: { readonly ativo: boolean; readonly caminho?: string };
  readonly sshHosts?: number;
  readonly hostinger?: { readonly conectado: boolean };
  readonly lovable?: number;
  readonly email?: number;
  readonly remoto?: { readonly relay?: string; readonly aparelhos: number };
  readonly voz?: { readonly configurado: boolean; readonly modo?: string };
  /** Repositório do sync de configurações (`fakl.sync.repository`). */
  readonly sync?: string;
  /** A pasta da CLI `fakl` já está no PATH do sistema. */
  readonly cliNoPath: boolean;
}

/** Progresso guardado no globalState. */
export interface SetupProgress {
  readonly puladas: readonly SetupStepId[];
  /** Etapas que só contam como feitas porque a pessoa as fez pela jornada. */
  readonly feitas: readonly SetupStepId[];
  /** Integrações marcadas no início; `undefined` antes da escolha. */
  readonly interesses?: readonly SetupStepId[];
  /** Dicas do tour (balões nas telas da FaKL) que a pessoa já dispensou. */
  readonly dicasVistas?: readonly string[];
  /** A pessoa pediu para não ver mais nenhuma dica. */
  readonly dicasDesligadas?: boolean;
}

export const EMPTY_PROGRESS: SetupProgress = { puladas: [], feitas: [] };

interface StepDefinition {
  readonly id: SetupStepId;
  readonly grupo: SetupGroup;
  readonly titulo: string;
  readonly resumo: string;
  /** Precisa do Core para saber o estado ou para configurar. */
  readonly core: boolean;
}

function steps(): StepDefinition[] {
  return [
    {
      id: 'idioma',
      grupo: 'essencial',
      titulo: l10n.t('Language'),
      resumo: l10n.t(
        'The IDE follows your system language. Switch between English and Portuguese (Brazil) at any time; the IDE restarts to apply it.',
      ),
      core: false,
    },
    {
      id: 'importar',
      grupo: 'essencial',
      titulo: l10n.t('Bring your editor along'),
      resumo: l10n.t(
        'Imports settings, keybindings, snippets and extensions from VS Code, VS Code Insiders or VSCodium.',
      ),
      core: false,
    },
    {
      id: 'tema',
      grupo: 'essencial',
      titulo: l10n.t('Theme'),
      resumo: l10n.t(
        '{0} has the same look as the Desk and the chat. Any VS Code theme works.',
        THEME_NAME,
      ),
      core: false,
    },
    {
      id: 'ia',
      grupo: 'essencial',
      titulo: l10n.t('AI providers'),
      resumo: l10n.t(
        'Use what you have: a Claude or Codex subscription through their CLIs, an API key (the only way for Gemini), local models (Ollama, LM Studio) or any ACP agent. With none, the IDE works as an editor.',
      ),
      core: true,
    },
    {
      id: 'doctor',
      grupo: 'essencial',
      titulo: l10n.t('Check this computer'),
      resumo: l10n.t(
        'The Doctor looks for what agents need (Node.js, the Claude, Codex and Gemini programs, sign-ins) and says how to fix each thing. Docker is not needed.',
      ),
      core: false,
    },
    {
      id: 'permissoes',
      grupo: 'essencial',
      titulo: l10n.t('Agent permissions'),
      resumo: l10n.t(
        'How much agents can do without asking, and a daily spending cap for each provider.',
      ),
      core: true,
    },
    {
      id: 'github',
      grupo: 'integracao',
      titulo: 'GitHub',
      resumo: l10n.t(
        'Pull requests, reviews, Actions and notifications for your whole account, plus pushes and PRs made by agents.',
      ),
      core: true,
    },
    {
      id: 'fontes',
      grupo: 'integracao',
      titulo: l10n.t('Agents, skills and MCPs'),
      resumo: l10n.t(
        'The IDE ships with none. Add sources (a git repository or a folder) and install only what you want.',
      ),
      core: true,
    },
    {
      id: 'vault',
      grupo: 'integracao',
      titulo: l10n.t('Notes vault'),
      resumo: l10n.t(
        'Obsidian-compatible Markdown notes with links, graph, daily notes and git sync.',
      ),
      core: true,
    },
    {
      id: 'ssh',
      grupo: 'integracao',
      titulo: l10n.t('SSH servers'),
      resumo: l10n.t(
        'Open remote folders in the same window and let agents run commands under each host’s rules. ~/.ssh/config is already read.',
      ),
      core: true,
    },
    {
      id: 'hostinger',
      grupo: 'integracao',
      titulo: 'Hostinger',
      resumo: l10n.t('VPS, DNS and firewall through the API, with each VPS becoming an SSH host.'),
      core: true,
    },
    {
      id: 'lovable',
      grupo: 'integracao',
      titulo: 'Lovable',
      resumo: l10n.t('Links a repository to a Lovable project to open and follow it from the IDE.'),
      core: true,
    },
    {
      id: 'email',
      grupo: 'integracao',
      titulo: l10n.t('Email (IMAP)'),
      resumo: l10n.t(
        'An inbox in the IDE and email reading for agents; the password stays in the system keychain.',
      ),
      core: true,
    },
    {
      id: 'remoto',
      grupo: 'integracao',
      titulo: l10n.t('Phone remote control'),
      resumo: l10n.t(
        'Follow and command your agents from your phone through your own relay, with end-to-end encryption.',
      ),
      core: true,
    },
    {
      id: 'voz',
      grupo: 'integracao',
      titulo: l10n.t('Voice commands'),
      resumo: l10n.t(
        'Speak a request instead of typing it: through the phone browser, OpenAI, Groq or a local server.',
      ),
      core: true,
    },
    {
      id: 'sync',
      grupo: 'integracao',
      titulo: l10n.t('Settings sync'),
      resumo: l10n.t(
        'Carries settings, keybindings and extensions between machines through a private repository of yours.',
      ),
      core: false,
    },
    {
      id: 'cli',
      grupo: 'integracao',
      titulo: l10n.t('fakl CLI in the terminal'),
      resumo: l10n.t(
        'The fakl command (tasks, agents, costs) already works in the IDE terminal; this puts it on the system PATH.',
      ),
      core: false,
    },
    {
      id: 'tour',
      grupo: 'essencial',
      titulo: l10n.t('Tour of FaKL-Code'),
      resumo: l10n.t(
        'A short walk through the Desk, the chat, the café, the vault, GitHub and phone control, with a first task you can run in a sample folder. Skip it any time; "FaKL: Tour" brings it back.',
      ),
      core: false,
    },
  ];
}

/** Integrações já marcadas na tela de início, antes de a pessoa mexer. */
export const DEFAULT_INTERESTS: readonly SetupStepId[] = ['github', 'fontes'];

export function permissionOptions(): SetupPermissionOption[] {
  return [
    {
      id: 'perguntar',
      rotulo: l10n.t('Ask'),
      descricao: l10n.t('The agent asks permission for every action. The safest way to start.'),
    },
    {
      id: 'aprovar-leitura',
      rotulo: l10n.t('Approve reads'),
      descricao: l10n.t('Reads and searches go through; edits and commands ask.'),
    },
    {
      id: 'aprovar-tudo',
      rotulo: l10n.t('Approve all'),
      descricao: l10n.t('The agent never asks for permission.'),
    },
    {
      id: 'autopilot',
      rotulo: 'Autopilot',
      descricao: l10n.t(
        'Approves everything and takes the safe option without waiting for you; the work stays on the agent’s branch.',
      ),
    },
  ];
}

const RELAY_HOST = /^https?:\/\/([^/]+)/;

/** Se a etapa está feita e a linha que diz o quê; `undefined` quando não dá para saber. */
function progressOf(
  id: SetupStepId,
  snapshot: SetupSnapshot,
  feitas: ReadonlySet<SetupStepId>,
): { feito: boolean; detalhe?: string } | undefined {
  switch (id) {
    case 'idioma':
      return {
        feito: feitas.has(id),
        ...(snapshot.idioma
          ? { detalhe: l10n.t('Interface language: {0}.', languageName(snapshot.idioma)) }
          : {}),
      };
    case 'importar':
      return feitas.has(id) ? { feito: true, detalhe: l10n.t('Imported.') } : { feito: false };
    case 'tema':
      return {
        feito: snapshot.tema === THEME_NAME || feitas.has(id),
        ...(snapshot.tema ? { detalhe: l10n.t('Current theme: {0}.', snapshot.tema) } : {}),
      };
    case 'ia': {
      if (!snapshot.provedores) return undefined;
      const prontos = snapshot.provedores.filter((status) => status.pronto);
      const nomes = prontos.map((status) => status.nome).join(', ');
      if (prontos.length === 0) {
        return {
          feito: false,
          detalhe: l10n.t('No provider ready yet; the IDE works without AI.'),
        };
      }
      return {
        feito: true,
        detalhe:
          prontos.length === 1
            ? l10n.t('1 ready: {0}.', nomes)
            : l10n.t('{0} ready: {1}.', prontos.length, nomes),
      };
    }
    case 'doctor':
      return { feito: feitas.has(id) };
    case 'tour':
      return { feito: feitas.has(id) };
    case 'permissoes':
      if (!snapshot.permissoes) return undefined;
      return {
        feito: feitas.has(id),
        detalhe: l10n.t(
          'Default: {0}.',
          permissionOptions().find((option) => option.id === snapshot.permissoes)?.rotulo ??
            snapshot.permissoes,
        ),
      };
    case 'github':
      if (!snapshot.github) return undefined;
      return snapshot.github.conectado
        ? {
            feito: true,
            detalhe: snapshot.github.usuario
              ? l10n.t('Signed in as {0}.', snapshot.github.usuario)
              : l10n.t('Connected.'),
          }
        : { feito: false };
    case 'fontes':
      if (snapshot.fontes === undefined) return undefined;
      if (snapshot.fontes === 0) return { feito: false };
      return {
        feito: true,
        detalhe:
          snapshot.fontes === 1
            ? l10n.t('1 source added.')
            : l10n.t('{0} sources added.', snapshot.fontes),
      };
    case 'vault':
      if (!snapshot.vault) return undefined;
      return snapshot.vault.ativo
        ? {
            feito: true,
            detalhe: snapshot.vault.caminho
              ? l10n.t('Vault at {0}.', snapshot.vault.caminho)
              : l10n.t('Active.'),
          }
        : { feito: false };
    case 'ssh':
      if (snapshot.sshHosts === undefined) return undefined;
      if (snapshot.sshHosts === 0) return { feito: false };
      return {
        feito: true,
        detalhe:
          snapshot.sshHosts === 1
            ? l10n.t('1 host available.')
            : l10n.t('{0} hosts available.', snapshot.sshHosts),
      };
    case 'hostinger':
      if (!snapshot.hostinger) return undefined;
      return snapshot.hostinger.conectado
        ? { feito: true, detalhe: l10n.t('Connected.') }
        : { feito: false };
    case 'lovable':
      if (snapshot.lovable === undefined) return undefined;
      if (snapshot.lovable === 0) return { feito: false };
      return {
        feito: true,
        detalhe:
          snapshot.lovable === 1
            ? l10n.t('1 project linked.')
            : l10n.t('{0} projects linked.', snapshot.lovable),
      };
    case 'email':
      if (snapshot.email === undefined) return undefined;
      if (snapshot.email === 0) return { feito: false };
      return {
        feito: true,
        detalhe:
          snapshot.email === 1 ? l10n.t('1 account.') : l10n.t('{0} accounts.', snapshot.email),
      };
    case 'remoto': {
      if (!snapshot.remoto) return undefined;
      const host = snapshot.remoto.relay ? RELAY_HOST.exec(snapshot.remoto.relay)?.[1] : undefined;
      if (!host) return { feito: false };
      return {
        feito: true,
        detalhe:
          snapshot.remoto.aparelhos === 1
            ? l10n.t('Relay {0}; 1 paired device.', host)
            : l10n.t('Relay {0}; {1} paired devices.', host, snapshot.remoto.aparelhos),
      };
    }
    case 'voz':
      if (!snapshot.voz) return undefined;
      return snapshot.voz.configurado
        ? {
            feito: true,
            detalhe: snapshot.voz.modo
              ? l10n.t('Mode: {0}.', snapshot.voz.modo)
              : l10n.t('Configured.'),
          }
        : { feito: false };
    case 'sync':
      return snapshot.sync
        ? { feito: true, detalhe: l10n.t('Syncing with {0}.', snapshot.sync) }
        : { feito: false };
    case 'cli':
      return snapshot.cliNoPath || feitas.has(id)
        ? { feito: true, detalhe: l10n.t('fakl is on the system PATH.') }
        : { feito: false };
  }
}

function actionsOf(id: SetupStepId, snapshot: SetupSnapshot): SetupAction[] {
  switch (id) {
    case 'idioma':
      return [
        { id: 'workbench.action.configureLocale', rotulo: l10n.t('Change language') },
        {
          id: 'idioma.manter',
          rotulo: l10n.t('Keep {0}', languageName(snapshot.idioma ?? 'en')),
          principal: true,
        },
      ];
    case 'importar':
      return [{ id: 'fakl.settings.import', rotulo: l10n.t('Import'), principal: true }];
    case 'tema':
      return [
        ...(snapshot.tema === THEME_NAME
          ? []
          : [{ id: 'tema.aplicar', rotulo: l10n.t('Use {0}', THEME_NAME), principal: true }]),
        { id: 'workbench.action.selectTheme', rotulo: l10n.t('Pick another theme') },
      ];
    case 'ia': {
      const claude = snapshot.provedores?.find((status) => status.id === 'anthropic');
      // A chave de API fica na linha de cada provedor.
      return [
        { id: 'fakl.providers.addAcp', rotulo: l10n.t('Add an ACP agent') },
        ...(claude?.instalado
          ? [{ id: 'fakl.claude.login', rotulo: l10n.t('Add another Claude account') }]
          : []),
      ];
    }
    case 'doctor':
      return [{ id: 'fakl.doctor.open', rotulo: l10n.t('Run the Doctor'), principal: true }];
    case 'tour':
      return [{ id: 'fakl.tour.open', rotulo: l10n.t('Start the tour'), principal: true }];
    case 'permissoes':
      return [];
    case 'github':
      return [{ id: 'fakl.github.login', rotulo: l10n.t('Sign in to GitHub'), principal: true }];
    case 'fontes':
      return [
        { id: 'fakl.resources.sources.add', rotulo: l10n.t('Add a source'), principal: true },
        ...(snapshot.fontes
          ? [
              { id: 'fakl.resources.agents.install', rotulo: l10n.t('Install agents') },
              { id: 'fakl.resources.skills.install', rotulo: l10n.t('Install skills') },
              { id: 'fakl.resources.mcpLibrary.install', rotulo: l10n.t('Install MCPs') },
            ]
          : []),
      ];
    case 'vault':
      return [
        { id: 'fakl.vault.configure', rotulo: l10n.t('Set up the vault'), principal: true },
        ...(snapshot.vault?.ativo
          ? [{ id: 'fakl.vault.embeddings.configure', rotulo: l10n.t('Semantic search') }]
          : []),
      ];
    case 'ssh':
      return [
        { id: 'fakl.ssh.add', rotulo: l10n.t('Add a host'), principal: true },
        { id: 'fakl.ssh.keygen', rotulo: l10n.t('Generate an SSH key') },
        { id: 'fakl.ssh.editConfig', rotulo: l10n.t('Open ~/.ssh/config') },
      ];
    case 'hostinger':
      return [
        { id: 'fakl.hostinger.connect', rotulo: l10n.t('Connect to Hostinger'), principal: true },
      ];
    case 'lovable':
      return [{ id: 'fakl.lovable.link', rotulo: l10n.t('Link a repository'), principal: true }];
    case 'email':
      return [{ id: 'fakl.email.addAccount', rotulo: l10n.t('Add an account'), principal: true }];
    case 'remoto':
      return [
        { id: 'remoto.guia', rotulo: l10n.t('How to run the relay') },
        {
          id: 'fakl.remote.configure',
          rotulo: snapshot.remoto?.relay ? l10n.t('Change the relay') : l10n.t('Set up the relay'),
          principal: !snapshot.remoto?.relay,
        },
        ...(snapshot.remoto?.relay
          ? [{ id: 'fakl.remote.pair', rotulo: l10n.t('Pair a phone'), principal: true }]
          : []),
      ];
    case 'voz':
      return [
        {
          id: 'fakl.voz.configurar',
          rotulo: snapshot.voz?.configurado ? l10n.t('Change the mode') : l10n.t('Choose a mode'),
          principal: true,
        },
      ];
    case 'sync':
      return [{ id: 'fakl.sync.configure', rotulo: l10n.t('Set up sync'), principal: true }];
    case 'cli':
      return [{ id: 'fakl.cli.addToPath', rotulo: l10n.t('Add to PATH'), principal: true }];
  }
}

export function stepViews(snapshot: SetupSnapshot, progress: SetupProgress): SetupStepView[] {
  const feitas = new Set(progress.feitas);
  const puladas = new Set(progress.puladas);
  const interesses = new Set(progress.interesses ?? DEFAULT_INTERESTS);
  return steps().map((step): SetupStepView => {
    const known =
      step.core && !snapshot.conectado ? undefined : progressOf(step.id, snapshot, feitas);
    let estado: SetupStepState;
    if (known?.feito) estado = 'feito';
    else if (puladas.has(step.id)) estado = 'pulado';
    else if (!known) estado = 'indisponivel';
    else estado = 'pendente';
    return {
      id: step.id,
      grupo: step.grupo,
      titulo: step.titulo,
      resumo: step.resumo,
      estado,
      ...(known?.detalhe ? { detalhe: known.detalhe } : {}),
      acoes: estado === 'indisponivel' ? [] : actionsOf(step.id, snapshot),
      escolhida: step.grupo === 'essencial' || interesses.has(step.id),
    };
  });
}

/** Comando de terminal de uma ação de provedor (instalar ou login); o resto não usa terminal. */
export function providerCommand(
  status: ProviderStatus,
  acao: ProviderActionId,
): string | undefined {
  if (status.pronto) return undefined;
  // Para servidores locais, `instalar` é uma instrução para ler, não um comando.
  if (acao === 'instalar' && !status.instalado && status.tipo !== 'local') return status.instalar;
  if (acao === 'login' && status.instalado && !status.chave) return status.login;
  return undefined;
}

function providerLine(status: ProviderStatus): string {
  if (status.pronto) return statusLine(status).description;
  if (status.tipo === 'local') return l10n.t('local server not found');
  if (!status.instalado) return l10n.t('not installed');
  return status.versao
    ? l10n.t('installed (v{0}); sign-in missing', status.versao)
    : l10n.t('installed; sign-in missing');
}

/** Linhas do passo de IA: o estado de cada provedor e o que resolve o que falta. */
export function providerRows(statuses: readonly ProviderStatus[]): SetupProviderRow[] {
  return statuses.map((status) => {
    const acoes: SetupProviderRow['acoes'][number][] = [];
    if (providerCommand(status, 'instalar')) {
      acoes.push({ id: 'instalar', rotulo: l10n.t('Install') });
    }
    if (providerCommand(status, 'login')) acoes.push({ id: 'login', rotulo: l10n.t('Sign in') });
    if (status.tipo === 'cli' || status.chaveEnv) {
      acoes.push(
        status.chave
          ? { id: 'removerChave', rotulo: l10n.t('Remove the key') }
          : { id: 'chave', rotulo: l10n.t('Use an API key') },
      );
    }
    const aviso =
      status.aviso ?? (status.tipo === 'local' && !status.pronto ? status.instalar : undefined);
    return {
      id: status.id,
      nome: status.nome,
      pronto: status.pronto,
      linha: providerLine(status),
      ...(aviso ? { aviso } : {}),
      acoes,
    };
  });
}

/** Os tetos de gasto que a jornada oferece: um por provedor pronto (modelos locais não gastam). */
export function capRows(
  statuses: readonly ProviderStatus[],
  tetos: Readonly<Record<string, DailyCap>> = {},
): SetupCap[] {
  return statuses
    .filter((status) => status.pronto && status.tipo !== 'local')
    .map((status) => {
      const custoUsd = tetos[status.id]?.custoUsd;
      return {
        provedor: status.id,
        nome: status.nome || providerName(status.id),
        ...(custoUsd !== undefined ? { custoUsd } : {}),
      };
    });
}

/** A tela inteira da jornada. */
export function setupView(
  snapshot: SetupSnapshot,
  progress: SetupProgress,
  abrir?: SetupStepId,
): SetupView {
  return {
    conectado: snapshot.conectado,
    etapas: stepViews(snapshot, progress),
    ...(snapshot.provedores ? { provedores: providerRows(snapshot.provedores) } : {}),
    ...(snapshot.permissoes
      ? {
          permissoes: {
            atual: snapshot.permissoes,
            opcoes: permissionOptions(),
            tetos: capRows(snapshot.provedores ?? [], snapshot.tetos),
          },
        }
      : {}),
    interessesEscolhidos: progress.interesses !== undefined,
    ...(abrir ? { abrir } : {}),
  };
}

/** Context keys do walkthrough nativo: `fakl.setup.<etapa>` verdadeira quando feita ou pulada. */
export function contextKeys(steps: readonly SetupStepView[]): Record<string, boolean> {
  return Object.fromEntries(
    steps.map((step) => [
      `fakl.setup.${step.id}`,
      step.estado === 'feito' || step.estado === 'pulado',
    ]),
  );
}

/** Quantas das etapas escolhidas estão resolvidas (feitas ou puladas). */
export function setupProgress(steps: readonly SetupStepView[]): { feitas: number; total: number } {
  const chosen = steps.filter((step) => step.escolhida);
  return {
    feitas: chosen.filter((step) => step.estado === 'feito' || step.estado === 'pulado').length,
    total: chosen.length,
  };
}

export function isSetupStepId(value: unknown): value is SetupStepId {
  return typeof value === 'string' && (SETUP_STEP_IDS as readonly string[]).includes(value);
}

/** Atualiza o progresso guardado sem repetir ids. */
export function withStep(
  progress: SetupProgress,
  key: 'puladas' | 'feitas',
  id: SetupStepId,
): SetupProgress {
  const other = key === 'puladas' ? 'feitas' : 'puladas';
  return {
    ...progress,
    [key]: [...new Set([...progress[key], id])],
    // Fazer uma etapa pulada tira o "pulado"; pular não desfaz o que foi feito.
    ...(key === 'feitas' ? { [other]: progress[other].filter((step) => step !== id) } : {}),
  };
}
