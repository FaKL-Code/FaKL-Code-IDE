import { l10n } from '@fakl/i18n';
import type { AgentStartResult, Task } from '@fakl/protocol';
import type { IntencaoDeVoz, PedidoDeVoz } from '@fakl/voz';

/** Chamada ao Core; `undefined` quando falhou (o app já avisou o erro). */
export type Chamar = <T>(method: string, params?: unknown) => Promise<T | undefined>;

/** O que a folha "O que você quer?" juntou: o pedido interpretado e as escolhas da pessoa. */
export interface EnvioDeVoz {
  readonly intencao: IntencaoDeVoz;
  /** Texto final, editado na folha. */
  readonly texto: string;
  /** Interpretação da fala: dela vêm título, critério e "começar agora". */
  readonly pedido: PedidoDeVoz;
  /** Pasta escolhida (tarefa e execução avulsa). */
  readonly repoPath: string;
  /** Maestro da tarefa ou perfil do agente avulso. */
  readonly perfilId?: string;
  /** Conversa aberta que recebe a mensagem. */
  readonly sessionId?: string;
}

/** Para onde o app vai depois de enviar. */
export type DestinoDeVoz =
  | { readonly name: 'tarefa'; readonly taskId: string }
  | { readonly name: 'conversa'; readonly sessionId: string };

export type ResultadoDeEnvio =
  | { readonly ok: true; readonly destino: DestinoDeVoz; readonly aviso: string }
  | { readonly ok: false; readonly motivo: string };

/** O que já foi criado no Core por este pedido; a nova tentativa repete só o que falhou. */
export interface ProgressoDeEnvio {
  /** Agente avulso já iniciado. */
  sessionId?: string;
  /** Tarefa já criada. */
  taskId?: string;
}

const TITULO_MAX = 80;

/** O que o pedido manda: o texto interpretado (o da confirmação) ou, sem ele, a fala. */
export function textoDoPedido(pedido: PedidoDeVoz, fala: string): string {
  return pedido.texto.trim() || fala.trim();
}

/** Título curto quando a interpretação não deu um: a primeira linha do pedido. */
export function tituloDoPedido(texto: string): string {
  const linha = (texto.split('\n').find((l) => l.trim()) ?? '').trim().replace(/\s+/g, ' ');
  return linha.length <= TITULO_MAX ? linha : `${linha.slice(0, TITULO_MAX - 1).trimEnd()}…`;
}

/** O que falta para enviar, no idioma da interface; `undefined` quando está tudo. */
export function faltaParaEnviar(envio: EnvioDeVoz): string | undefined {
  if (!envio.texto.trim()) return l10n.t('Say or type what you want.');
  if (envio.intencao === 'mensagem') {
    return envio.sessionId ? undefined : l10n.t('Open a conversation to send the message.');
  }
  if (!envio.repoPath.trim()) return l10n.t('Choose the folder or repository.');
  if (envio.intencao === 'avulsa' && !envio.perfilId) return l10n.t('Choose the agent.');
  return undefined;
}

/**
 * Transforma o pedido nas chamadas ao Core, as mesmas das telas "Nova
 * tarefa" e "Nova conversa": tarefa → `tasks.create` (+ `runs.start`),
 * avulsa → `agents.start` + `agents.send`, mensagem → `agents.send`.
 */
export async function enviarPedido(
  call: Chamar,
  envio: EnvioDeVoz,
  progresso: ProgressoDeEnvio = {},
): Promise<ResultadoDeEnvio> {
  const motivo = faltaParaEnviar(envio);
  if (motivo) return { ok: false, motivo };
  const texto = envio.texto.trim();

  if (envio.intencao === 'mensagem') {
    const sessionId = envio.sessionId ?? '';
    const enviada = await call('agents.send', { sessionId, message: texto });
    if (enviada === undefined) {
      return { ok: false, motivo: l10n.t("Couldn't send the message.") };
    }
    return {
      ok: true,
      destino: { name: 'conversa', sessionId },
      aviso: l10n.t('Message sent.'),
    };
  }

  if (envio.intencao === 'avulsa') {
    if (!progresso.sessionId) {
      const iniciada = await call<AgentStartResult>('agents.start', {
        profileId: envio.perfilId,
        cwd: envio.repoPath.trim(),
        worktree: envio.pedido.worktree ?? true,
      });
      if (!iniciada) return { ok: false, motivo: l10n.t("Couldn't start the agent.") };
      progresso.sessionId = iniciada.sessionId;
    }
    const sessionId = progresso.sessionId;
    const enviada = await call('agents.send', { sessionId, message: texto });
    if (enviada === undefined) {
      return {
        ok: false,
        motivo: l10n.t("The agent started, but the request couldn't be sent. Try again."),
      };
    }
    return { ok: true, destino: { name: 'conversa', sessionId }, aviso: l10n.t('Agent started.') };
  }

  if (!progresso.taskId) {
    const comandos = envio.pedido.criterio ?? [];
    const criada = await call<Task>('tasks.create', {
      titulo: envio.pedido.titulo?.trim() ? envio.pedido.titulo.trim() : tituloDoPedido(texto),
      descricao: texto,
      repoPath: envio.repoPath.trim(),
      origem: 'remoto',
      ...(comandos.length > 0 ? { criterio: { comandos: [...comandos] } } : {}),
      ...(envio.perfilId ? { maestroProfileId: envio.perfilId } : {}),
    });
    if (!criada) return { ok: false, motivo: l10n.t("Couldn't create the task.") };
    progresso.taskId = criada.id;
  }
  const taskId = progresso.taskId;
  if (envio.pedido.comecarAgora) {
    const execucao = await call('runs.start', { taskId });
    if (execucao === undefined) {
      return {
        ok: false,
        motivo: l10n.t("The task was created, but it couldn't start. Try again."),
      };
    }
  }
  return {
    ok: true,
    destino: { name: 'tarefa', taskId },
    aviso: envio.pedido.comecarAgora
      ? l10n.t('Task created.')
      : l10n.t('Task created, not started.'),
  };
}
