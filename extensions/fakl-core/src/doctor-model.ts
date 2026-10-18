/**
 * "FaKL: Doctor": as regras que dizem, em linguagem simples, o que falta na
 * máquina para os agentes rodarem. Funções puras, sem VS Code: o host junta o
 * retrato ({@link DoctorSnapshot}, vindo de `providers.detect` e
 * `providers.environment`) e daqui saem os itens, cada um com o problema e a
 * ação (um botão ou o comando exato). Nada é instalado por aqui: comandos vão
 * ao terminal digitados, sem Enter.
 *
 * Os textos ficam em inglês em `l10n.t` e o pt-BR vem do catálogo `doctor`
 * do @fakl/i18n.
 */

import { l10n } from '@fakl/i18n';
import type {
  McpProbe,
  ProviderStatus,
  ProviderUpdate,
  ProvidersEnvironment,
} from '@fakl/protocol';

import { PRIVACY_GUIDE } from './rede-model.js';

/** Versão mínima do Node para os adaptadores: a 18 já saiu de suporte. */
export const MIN_NODE_MAJOR = 20;

export const NODE_DOWNLOAD = 'https://nodejs.org/en/download';
export const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';
export const RELAY_GUIDE =
  'https://github.com/FaKL-Code/FaKL-Code-IDE/blob/main/packages/relay/README.md';

/** O que a IDE consulta na rede sozinha e como desligar (ADR 0045). */
function networkItem(rede: NonNullable<DoctorSnapshot['rede']>): DoctorItem {
  const editorUpdates =
    rede.modoAtualizacao === 'none'
      ? l10n.t('The editor updater is off (update.mode is none).')
      : l10n.t('The editor updater is separate: set update.mode to none to turn it off.');
  const settings: DoctorAction = {
    tipo: 'comando',
    rotulo: l10n.t('Open the setting'),
    comando: 'workbench.action.openSettings',
    args: ['fakl.rede.consultasAutomaticas'],
  };
  const guide: DoctorAction = {
    tipo: 'link',
    rotulo: l10n.t('What the IDE queries'),
    url: PRIVACY_GUIDE,
  };
  if (rede.consultasAutomaticas) {
    return {
      id: 'rede',
      severidade: 'info',
      titulo: l10n.t('Automatic network queries are on'),
      detalhe: `${l10n.t(
        'The IDE asks npm for the latest agent connector versions and, on macOS, GitHub for a new IDE version. Only public package and release information is requested; no code or account data is sent. The setting fakl.rede.consultasAutomaticas turns both off.',
      )} ${editorUpdates}`,
      acoes: [settings, guide],
    };
  }
  return {
    id: 'rede',
    severidade: 'info',
    titulo: l10n.t('Automatic network queries are off'),
    detalhe: `${l10n.t(
      'The IDE does not ask npm or GitHub for versions on its own. You can still check the connectors by hand.',
    )} ${editorUpdates}`,
    acoes: [
      {
        tipo: 'comando',
        rotulo: l10n.t('Check adapter versions now'),
        comando: 'fakl.rede.verificarAdaptadores',
      },
      settings,
      guide,
    ],
  };
}

export type DoctorSeverity = 'ok' | 'info' | 'aviso' | 'problema';

export type DoctorAction =
  /** Um comando da própria IDE. */
  | {
      readonly tipo: 'comando';
      readonly rotulo: string;
      readonly comando: string;
      readonly args?: readonly string[];
    }
  /** Um comando de terminal, digitado sem Enter: quem confere e roda é a pessoa. */
  | {
      readonly tipo: 'terminal';
      readonly rotulo: string;
      readonly nome: string;
      readonly texto: string;
    }
  | { readonly tipo: 'link'; readonly rotulo: string; readonly url: string };

export interface DoctorItem {
  readonly id: string;
  readonly severidade: DoctorSeverity;
  readonly titulo: string;
  /** O problema (ou o que está certo) em uma ou duas frases, sem jargão. */
  readonly detalhe: string;
  readonly acoes: readonly DoctorAction[];
}

/** O que o diagnóstico sabe da máquina; `undefined` é "não deu para saber". */
export interface DoctorSnapshot {
  /** O Core respondeu; sem ele nada além do aviso é checado. */
  readonly conectado: boolean;
  readonly ambiente?: ProvidersEnvironment;
  readonly provedores?: readonly ProviderStatus[];
  /** Configurações que decidem o que a IDE consulta sozinha na rede (ADR 0045). */
  readonly rede?: {
    readonly consultasAutomaticas: boolean;
    /** Valor de `update.mode` do VS Code, quando definido. */
    readonly modoAtualizacao?: string;
  };
}

/** "22.13.0" de "v22.13.0"; o major, ou `undefined` se o texto não é uma versão. */
export function nodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number.parseInt(match[1] ?? '', 10) : undefined;
}

function terminalAction(status: ProviderStatus, rotulo: string, texto: string): DoctorAction {
  return { tipo: 'terminal', rotulo, nome: `FaKL: ${status.nome}`, texto };
}

function keyAction(status: ProviderStatus): DoctorAction {
  return {
    tipo: 'comando',
    rotulo: l10n.t('Use an API key'),
    comando: 'fakl.providers.setKey',
    args: [status.id],
  };
}

function updateAction(status: ProviderStatus, update: ProviderUpdate): DoctorAction {
  return terminalAction(status, l10n.t('Update ({0})', update.comando), update.atualizar);
}

/** O Gemini com login de conta Google pessoal: o Google não o aceita mais para agentes de terceiros. */
export function geminiPersonalLogin(status: ProviderStatus): boolean {
  return status.id === 'google' && status.loginTipo === 'oauth-personal' && !status.chave;
}

/** Pronto e, no caso do Gemini, num login que ainda funciona. */
function usable(status: ProviderStatus): boolean {
  return status.pronto && !geminiPersonalLogin(status);
}

/** Itens de um provedor com CLI; vazio quando está tudo certo e em dia (aí vem o item "pronto"). */
function providerItems(
  status: ProviderStatus,
  gap: DoctorSeverity,
): { readonly items: DoctorItem[]; readonly clean: boolean } {
  const items: DoctorItem[] = [];
  const name = status.nome;
  const cliInstalado = status.cliInstalado ?? status.instalado;
  const single = status.id === 'google';
  const key = status.chave;

  if (!status.instalado && !cliInstalado) {
    items.push({
      id: `${status.id}.instalacao`,
      severidade: gap,
      titulo: l10n.t('{0} is not installed', name),
      detalhe: l10n.t(
        'Agents for {0} need it. You only need one of the three providers, so skip this one if you do not use it.',
        name,
      ),
      acoes: status.instalar ? [terminalAction(status, l10n.t('Install'), status.instalar)] : [],
    });
    return { items, clean: false };
  }

  if (!status.instalado) {
    items.push({
      id: `${status.id}.adaptador`,
      severidade: gap,
      titulo: l10n.t('{0}: the IDE connector is missing', name),
      detalhe: l10n.t(
        'The connector is the small program that lets the IDE talk to {0}. Install it once.',
        name,
      ),
      acoes: status.instalar ? [terminalAction(status, l10n.t('Install'), status.instalar)] : [],
    });
  } else if (!cliInstalado && !key) {
    items.push({
      id: `${status.id}.cli`,
      severidade: gap,
      titulo: l10n.t('{0}: the official program is missing', name),
      detalhe: l10n.t(
        'It is where you sign in with your subscription. Install it, or use an API key instead.',
      ),
      acoes: [
        ...(status.instalar ? [terminalAction(status, l10n.t('Install'), status.instalar)] : []),
        keyAction(status),
      ],
    });
  }

  if (geminiPersonalLogin(status)) {
    items.push({
      id: 'google.login',
      severidade: 'problema',
      titulo: l10n.t('Gemini: personal Google sign-in no longer works'),
      detalhe: l10n.t(
        'Google stopped accepting personal accounts for this use. Use an API key from Google AI Studio (or Vertex) instead.',
      ),
      acoes: [
        keyAction(status),
        { tipo: 'link', rotulo: l10n.t('Get a key'), url: GEMINI_KEY_PAGE },
      ],
    });
  } else if (status.instalado && !status.pronto && status.id === 'google') {
    // O login com conta Google pessoal falha para terceiros: a chave vem na frente.
    items.push({
      id: 'google.login',
      severidade: gap,
      titulo: l10n.t('{0}: not signed in', name),
      detalhe: l10n.t(
        'Use an API key from Google AI Studio (or Vertex). A personal Google account no longer works here; only a Workspace Standard or Enterprise account may still sign in.',
      ),
      acoes: [
        keyAction(status),
        { tipo: 'link', rotulo: l10n.t('Get a key'), url: GEMINI_KEY_PAGE },
        ...(status.login ? [terminalAction(status, l10n.t('Sign in'), status.login)] : []),
      ],
    });
  } else if (status.instalado && !status.pronto) {
    items.push({
      id: `${status.id}.login`,
      severidade: gap,
      titulo: l10n.t('{0}: not signed in', name),
      detalhe: l10n.t('Sign in with your subscription, or store an API key.'),
      acoes: [
        ...(status.login ? [terminalAction(status, l10n.t('Sign in'), status.login)] : []),
        keyAction(status),
      ],
    });
  }

  const outdated = (status.atualizacoes ?? []).filter((update) => update.desatualizada);
  for (const update of outdated) {
    const what =
      update.papel === 'adaptador' && !single
        ? l10n.t('the connector')
        : l10n.t('the official program');
    items.push({
      id: `${status.id}.${update.papel ?? 'pacote'}.atualizacao`,
      severidade: 'aviso',
      titulo: l10n.t('{0}: {1} is out of date', name, what),
      detalhe: l10n.t(
        'Installed {0}, latest {1}. An old one can hide new models.',
        update.instalada,
        update.ultima,
      ),
      acoes: [updateAction(status, update)],
    });
  }

  return { items, clean: items.length === 0 };
}

function readyDetail(status: ProviderStatus): string {
  const how =
    status.modo === 'chave'
      ? l10n.t('with an API key')
      : status.modo === 'assinatura'
        ? l10n.t('with your subscription')
        : '';
  return [how, status.versao ? `v${status.versao}` : ''].filter(Boolean).join(', ');
}

/** O servidor MCP `fakl`, que dá aos agentes as ferramentas do Maestro: ok, ou o motivo e como corrigir. */
function mcpItem(probe: McpProbe): DoctorItem {
  if (probe.ok) {
    return {
      id: 'mcp',
      severidade: 'ok',
      titulo: l10n.t('FaKL MCP server: ok'),
      detalhe: l10n.t('It answered and listed {0} tools for the agents.', probe.ferramentas ?? 0),
      acoes: [],
    };
  }
  const why =
    probe.motivo === 'nao-encontrado'
      ? l10n.t('The command that starts it was not found.')
      : probe.motivo === 'sem-resposta'
        ? l10n.t('It started but did not answer in time.')
        : probe.codigo === undefined
          ? l10n.t('It stopped right after starting.')
          : l10n.t('It exited with code {0}.', probe.codigo);
  const lines = probe.stderr
    ? ` ${l10n.t(
        'Its last output: {0}',
        probe.stderr
          .trim()
          .split(/[\r\n]+/)
          .slice(-3)
          .join(' | '),
      )}`
    : '';
  return {
    id: 'mcp',
    severidade: 'aviso',
    titulo: l10n.t('FaKL MCP server failed to start'),
    detalhe: `${why}${lines} ${l10n.t(
      'Without it the Maestro tools do not show up for the agent. Reload the window; and if you reopened an IDE conversation in the official Codex or Claude extension, start the agent from the Desk instead, because that extension can start the server without the IDE environment.',
    )}`,
    acoes: [
      {
        tipo: 'comando',
        rotulo: l10n.t('Reload window'),
        comando: 'workbench.action.reloadWindow',
      },
    ],
  };
}

/** O diagnóstico inteiro, na ordem em que a tela mostra. */
export function diagnose(snapshot: DoctorSnapshot): DoctorItem[] {
  const docker: DoctorItem = {
    id: 'docker',
    severidade: 'info',
    titulo: l10n.t('Docker is not needed'),
    detalhe: l10n.t(
      'Agents run on this machine without Docker. The only use is the optional phone remote control, whose relay runs on your own server.',
    ),
    acoes: [{ tipo: 'link', rotulo: l10n.t('About the phone relay'), url: RELAY_GUIDE }],
  };
  if (!snapshot.conectado) {
    return [
      {
        id: 'core',
        severidade: 'problema',
        titulo: l10n.t('The FaKL Core is not responding'),
        detalhe: l10n.t(
          'The part of the IDE that runs agents did not answer. Reloading the window usually brings it back.',
        ),
        acoes: [
          {
            tipo: 'comando',
            rotulo: l10n.t('Reload window'),
            comando: 'workbench.action.reloadWindow',
          },
        ],
      },
      docker,
    ];
  }

  const items: DoctorItem[] = [];
  const { ambiente } = snapshot;
  if (ambiente) {
    const major = ambiente.node ? nodeMajor(ambiente.node) : undefined;
    if (!ambiente.node) {
      items.push({
        id: 'node',
        severidade: 'problema',
        titulo: l10n.t('Node.js not found'),
        detalhe: l10n.t(
          'The agent connectors for Claude, Codex and Gemini run on Node.js. Install it, then reopen the IDE.',
        ),
        acoes: [{ tipo: 'link', rotulo: l10n.t('Download Node.js'), url: NODE_DOWNLOAD }],
      });
    } else if (major !== undefined && major < MIN_NODE_MAJOR) {
      items.push({
        id: 'node',
        severidade: 'aviso',
        titulo: l10n.t('Node.js {0} is too old', ambiente.node),
        detalhe: l10n.t(
          'Version {0} or newer is needed. Install a current one, then reopen the IDE.',
          MIN_NODE_MAJOR,
        ),
        acoes: [{ tipo: 'link', rotulo: l10n.t('Download Node.js'), url: NODE_DOWNLOAD }],
      });
    } else {
      items.push({
        id: 'node',
        severidade: 'ok',
        titulo: l10n.t('Node.js {0}', ambiente.node),
        detalhe: l10n.t('Found and recent enough.'),
        acoes: [],
      });
    }
    if (!ambiente.npm) {
      items.push({
        id: 'npm',
        severidade: ambiente.node ? 'problema' : 'info',
        titulo: l10n.t('npm not found'),
        detalhe: l10n.t(
          'npm installs and updates the agent connectors. It normally comes with Node.js.',
        ),
        acoes: [{ tipo: 'link', rotulo: l10n.t('Download Node.js'), url: NODE_DOWNLOAD }],
      });
    } else {
      items.push({
        id: 'npm',
        severidade: 'ok',
        titulo: l10n.t('npm {0}', ambiente.npm),
        detalhe: l10n.t('Found.'),
        acoes: [],
      });
    }
  }

  if (ambiente?.mcp) items.push(mcpItem(ambiente.mcp));

  const clis = (snapshot.provedores ?? []).filter((status) => status.tipo === 'cli');
  if (snapshot.provedores) {
    const anyReady = snapshot.provedores.some(usable);
    items.push(
      anyReady
        ? {
            id: 'agentes',
            severidade: 'ok',
            titulo: l10n.t('At least one agent is ready'),
            detalhe: l10n.t('You can start an agent from the Desk or the chat.'),
            acoes: [],
          }
        : {
            id: 'agentes',
            severidade: 'problema',
            titulo: l10n.t('No agent is ready yet'),
            detalhe: l10n.t(
              'Pick one of the providers below and fix what it asks for. The IDE works as an editor in the meantime.',
            ),
            acoes: [],
          },
    );
    const gap: DoctorSeverity = anyReady ? 'info' : 'problema';
    for (const status of clis) {
      const { items: found, clean } = providerItems(status, gap);
      if (clean && usable(status)) {
        items.push({
          id: `${status.id}.ok`,
          severidade: 'ok',
          titulo: l10n.t('{0} is ready', status.nome),
          detalhe: readyDetail(status),
          acoes: [],
        });
      }
      items.push(...found);
    }
    const inEnv = new Set(ambiente?.chavesNoAmbiente ?? []);
    for (const status of clis.filter((candidate) => inEnv.has(candidate.id) && !candidate.chave)) {
      items.push({
        id: `${status.id}.chave-ambiente`,
        severidade: 'aviso',
        titulo: l10n.t('{0} is set on your system, not in the IDE', status.chaveEnv ?? 'API key'),
        detalhe: l10n.t(
          'Agents only receive keys stored in the IDE keychain, so this one is ignored. Store it in the IDE or remove it from your system.',
        ),
        acoes: [keyAction(status)],
      });
    }
  }

  if (snapshot.rede) items.push(networkItem(snapshot.rede));
  items.push(docker);
  return items;
}

/** Quantos itens pedem atenção, para o título da tela e para decidir se vale avisar. */
export function doctorSummary(items: readonly DoctorItem[]): {
  readonly problemas: number;
  readonly avisos: number;
} {
  return {
    problemas: items.filter((item) => item.severidade === 'problema').length,
    avisos: items.filter((item) => item.severidade === 'aviso').length,
  };
}

/** O que mais pesa: o primeiro problema, ou o primeiro aviso; `undefined` se está tudo certo. */
export function firstConcern(items: readonly DoctorItem[]): DoctorItem | undefined {
  return (
    items.find((item) => item.severidade === 'problema') ??
    items.find((item) => item.severidade === 'aviso')
  );
}

/** Ação oferecida pelo item `itemId`, pelo índice; a página só pede o que a tela mostrou. */
export function actionOf(
  items: readonly DoctorItem[],
  itemId: string,
  index: number,
): DoctorAction | undefined {
  return items.find((item) => item.id === itemId)?.acoes[index];
}
