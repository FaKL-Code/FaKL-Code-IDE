import { l10n } from '@fakl/i18n';
import { transcricaoDaVoz, type VozModo, type VozStatus } from '@fakl/protocol';
import type { IntencaoDeVoz, PedidoDeVoz, PerfilConhecido, RepoConhecido } from '@fakl/voz';

/**
 * Comandos por voz na IDE, sem vscode: o que um pedido interpretado vira
 * (criar tarefa, abrir agente, mandar mensagem) e os dados que alimentam a
 * interpretação. O host da extensão só executa o que sai daqui.
 */

/** O que a IDE sabe na hora de executar o pedido. */
export interface AmbienteDeVoz {
  /** Pasta aberta (local) onde a tarefa ou o agente trabalham sem a fala citar outra. */
  readonly repoPadrao?: string;
  /** Perfil pronto para um agente avulso quando a fala não citou nenhum. */
  readonly perfilPadrao?: string;
  /** Conversa aberta no chat, que recebe a fala como mensagem. */
  readonly sessaoAtiva?: string;
}

/** Parâmetros de `tasks.create` para uma tarefa ditada. */
export interface TarefaDeVoz {
  readonly titulo: string;
  readonly descricao: string;
  readonly origem: 'manual';
  readonly repoPath: string;
  readonly permissoes: 'perguntar';
  readonly maestroProfileId?: string;
  readonly criterio?: { readonly comandos: readonly string[] };
}

export type AcaoDeVoz =
  | { readonly tipo: 'tarefa'; readonly tarefa: TarefaDeVoz; readonly comecar: boolean }
  | {
      readonly tipo: 'avulsa';
      readonly profileId: string;
      readonly texto: string;
      readonly worktree: boolean;
      /** Pasta citada na fala; sem ela, o agente começa na primeira pasta aberta. */
      readonly repoPath?: string;
    }
  | { readonly tipo: 'mensagem'; readonly sessionId: string; readonly texto: string }
  | { readonly tipo: 'erro'; readonly mensagem: string };

const LIMITE_TITULO = 80;

/** Primeira linha do texto, cortada em 80 caracteres: o título de uma tarefa. */
export function tituloDaTarefa(texto: string): string {
  const linha = (texto.trim().split(/\r?\n/)[0] ?? '').trim();
  return linha.length > LIMITE_TITULO ? `${linha.slice(0, LIMITE_TITULO - 3)}...` : linha;
}

/** Decide o que fazer com o pedido; `erro` quando falta algo para executá-lo. */
export function acaoDoPedido(pedido: PedidoDeVoz, ambiente: AmbienteDeVoz): AcaoDeVoz {
  const texto = pedido.texto.trim();
  if (!texto)
    return { tipo: 'erro', mensagem: l10n.t('The request is empty. Speak or type it again.') };
  switch (pedido.intencao) {
    case 'tarefa': {
      const repoPath = pedido.repoPath ?? ambiente.repoPadrao;
      if (!repoPath) {
        return {
          tipo: 'erro',
          mensagem: l10n.t(
            'Open the repository folder (local, with git) for the maestro to work in.',
          ),
        };
      }
      const comandos = (pedido.criterio ?? []).map((c) => c.trim()).filter(Boolean);
      return {
        tipo: 'tarefa',
        tarefa: {
          titulo: pedido.titulo?.trim() ? pedido.titulo.trim() : tituloDaTarefa(texto),
          descricao: texto,
          origem: 'manual',
          repoPath,
          permissoes: 'perguntar',
          ...(pedido.perfilId ? { maestroProfileId: pedido.perfilId } : {}),
          ...(comandos.length > 0 ? { criterio: { comandos } } : {}),
        },
        comecar: pedido.comecarAgora,
      };
    }
    case 'avulsa': {
      const profileId = pedido.perfilId ?? ambiente.perfilPadrao;
      if (!profileId) {
        return {
          tipo: 'erro',
          mensagem: l10n.t('No agent is ready. Install or set up a profile and try again.'),
        };
      }
      return {
        tipo: 'avulsa',
        profileId,
        texto,
        worktree: pedido.worktree === true,
        ...(pedido.repoPath ? { repoPath: pedido.repoPath } : {}),
      };
    }
    case 'mensagem':
      if (!ambiente.sessaoAtiva) {
        return {
          tipo: 'erro',
          mensagem: l10n.t(
            'There is no open conversation in the chat. Choose "New conversation" or "Task".',
          ),
        };
      }
      return { tipo: 'mensagem', sessionId: ambiente.sessaoAtiva, texto };
  }
}

/** Intenções que a interface oferece; "mensagem" só com uma conversa aberta. */
export function intencoesPossiveis(conversaAberta: boolean): readonly IntencaoDeVoz[] {
  return conversaAberta ? ['tarefa', 'avulsa', 'mensagem'] : ['tarefa', 'avulsa'];
}

/** Rótulo de uma intenção no seletor do painel de voz. */
export function rotuloDaIntencao(intencao: IntencaoDeVoz): string {
  switch (intencao) {
    case 'tarefa':
      return l10n.t('Task');
    case 'avulsa':
      return l10n.t('New conversation');
    case 'mensagem':
      return l10n.t('Message to the active conversation');
  }
}

/**
 * Rótulos das intenções no seletor do painel de voz. Cada leitura chama
 * {@link rotuloDaIntencao}, então o texto sai no idioma escolhido em `useLocale`.
 */
export const ROTULOS_DE_INTENCAO: Readonly<Record<IntencaoDeVoz, string>> = {
  get tarefa() {
    return rotuloDaIntencao('tarefa');
  },
  get avulsa() {
    return rotuloDaIntencao('avulsa');
  },
  get mensagem() {
    return rotuloDaIntencao('mensagem');
  },
};

/** Perfis de `profiles.list` no formato que a interpretação reconhece. */
export function perfisDeVoz(
  perfis: readonly {
    readonly id: string;
    readonly nome: string;
    readonly modelo?: string;
    readonly provedor?: string;
  }[],
): PerfilConhecido[] {
  return perfis.map((perfil) => {
    const modelo = perfil.modelo ?? perfil.provedor;
    return { id: perfil.id, nome: perfil.nome, ...(modelo ? { modelo } : {}) };
  });
}

/** Pastas que a fala pode citar, sem repetir caminho. */
export function reposDeVoz(
  pastas: readonly { readonly caminho: string; readonly nome?: string }[],
): RepoConhecido[] {
  const vistos = new Set<string>();
  const repos: RepoConhecido[] = [];
  for (const pasta of pastas) {
    const chave = pasta.caminho.replace(/[\\/]+$/, '').toLowerCase();
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    repos.push(
      pasta.nome ? { caminho: pasta.caminho, nome: pasta.nome } : { caminho: pasta.caminho },
    );
  }
  return repos;
}

/** Um modo de voz no seletor de "Configurar voz". */
export interface ModoDeVoz {
  readonly id: VozModo;
  readonly nome: string;
  readonly descricao: string;
  /** `sim`: sem a chave a voz não liga; `opcional`: só se o servidor pedir. */
  readonly chave: 'nao' | 'sim' | 'opcional';
}

/** Modos que "Configurar voz" oferece, na ordem do seletor. A voz começa desligada. */
export function modosDeVoz(): readonly ModoDeVoz[] {
  return [
    {
      id: 'navegador',
      nome: l10n.t('Browser recognition'),
      descricao: l10n.t(
        'Free and keyless; works in the phone app (Chrome, Safari), not in the IDE',
      ),
      chave: 'nao',
    },
    {
      id: 'openai',
      nome: 'OpenAI',
      descricao: l10n.t('gpt-4o-mini-transcribe on the OpenAI API; needs a key'),
      chave: 'sim',
    },
    {
      id: 'groq',
      nome: 'Groq',
      descricao: l10n.t('Whisper on Groq: fast, with a free quota; needs a key'),
      chave: 'sim',
    },
    {
      id: 'local',
      nome: l10n.t('Local whisper-compatible server'),
      descricao: l10n.t('speaches, faster-whisper-server, whisper.cpp... at the address you give'),
      chave: 'opcional',
    },
  ];
}

/** Nome do modo para mensagens. */
export function nomeDoModo(modo: VozModo | undefined): string {
  return modosDeVoz().find((m) => m.id === modo)?.nome ?? l10n.t('off');
}

/** O que falta para a voz funcionar nos webviews da IDE (Electron). */
export function avisoNavegadorNaIde(): string {
  return l10n.t(
    'In browser mode, voice works in the phone app. In the IDE, use system dictation (Win+H on Windows) or choose OpenAI, Groq or a local server.',
  );
}

/**
 * Se o microfone da IDE funciona com este status. Na IDE quem transcreve é
 * sempre o Core: no Electron a Web Speech API não funciona, então o modo
 * navegador só vale no celular. `aviso` diz o que fazer quando não funciona.
 */
export function vozNaIde(status: VozStatus | undefined): { pronta: boolean; aviso?: string } {
  if (!status) return { pronta: false, aviso: l10n.t('FaKL Core is not responding.') };
  const quem = transcricaoDaVoz(status);
  if (quem === 'core') return { pronta: true };
  if (quem === 'navegador') return { pronta: false, aviso: avisoNavegadorNaIde() };
  if (!status.modo) {
    return {
      pronta: false,
      aviso: l10n.t(
        'Voice is off. Choose a mode: browser recognition (phone), OpenAI, Groq or a local server.',
      ),
    };
  }
  return {
    pronta: false,
    aviso: status.motivo
      ? l10n.t("Voice ({0}) isn't ready: {1}.", nomeDoModo(status.modo), status.motivo)
      : l10n.t("Voice ({0}) isn't ready.", nomeDoModo(status.modo)),
  };
}

/** Confere o endereço de um servidor de transcrição; `undefined` quando serve. */
export function problemaNoEndpoint(valor: string): string | undefined {
  try {
    const url = new URL(valor.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : l10n.t('Use an http:// or https:// address');
  } catch {
    return l10n.t('Invalid address; for example http://127.0.0.1:8000/v1');
  }
}

/** Converte bytes em base64 sem estourar a pilha com áudios grandes. */
export function bytesParaBase64(bytes: Uint8Array): string {
  let binario = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(binario);
}
