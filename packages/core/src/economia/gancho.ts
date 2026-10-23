import { createHash } from 'node:crypto';

import { l10n } from '@fakl/i18n';

import { compactarSaida, type ModoEconomia } from './compactar.js';

/**
 * Economia nas ferramentas próprias do Claude Code (ADR 0052). O modo econômico
 * já compacta as ferramentas MCP do Core, mas num chat ou numa tarefa o que
 * enche o contexto são as ferramentas do próprio agente: Bash, Read, Grep. O
 * adaptador do Claude aceita ganchos (hooks) por sessão, e este é o que eles
 * chamam: compacta a saída dos comandos, troca por um aviso a leitura que deu
 * exatamente o mesmo resultado de antes e, quando a conversa principal passa a
 * explorar o código sozinha, lembra do explorador barato.
 *
 * Cada chamada do gancho é um processo novo; o estado da sessão fica num arquivo.
 */

/** O que o Claude Code manda ao gancho (só os campos usados aqui). */
export interface EntradaDoGancho {
  readonly hook_event_name?: string;
  readonly session_id?: string;
  /** Só nas chamadas de um subagente: o contexto dele é outro. */
  readonly agent_id?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

export interface SomasDoGancho {
  respostas: number;
  caracteresCompactados: number;
  repeticoes: number;
  caracteresRepeticoes: number;
}

export interface EstadoDoGancho {
  /** Chamada (ferramenta, argumentos e quem chamou) para a impressão digital da última saída. */
  vistos: Record<string, string>;
  /** Leituras e buscas da conversa principal nesta rodada. */
  exploracao: number;
  /** O que ainda não foi registrado no Core. */
  somas: SomasDoGancho;
}

export interface ConfigDoGancho {
  readonly modo: ModoEconomia;
  /** Nome do subagente explorador da sessão, quando há um mais barato que ela. */
  readonly explorador?: string;
}

export interface ResultadoDoGancho {
  /** JSON que o gancho escreve na saída; nada quando não muda nada. */
  readonly saida?: unknown;
  /** Somas para mandar ao Core agora (fim da rodada). */
  readonly registrar?: SomasDoGancho;
}

const ZERO: SomasDoGancho = {
  respostas: 0,
  caracteresCompactados: 0,
  repeticoes: 0,
  caracteresRepeticoes: 0,
};

export function estadoInicial(): EstadoDoGancho {
  return { vistos: {}, exploracao: 0, somas: { ...ZERO } };
}

/** Saídas menores que isso não compensam um aviso no lugar. */
const REPETIDA_MIN = 1_200;
const VISTOS_MAX = 300;
const EXPLORACAO: Record<Exclude<ModoEconomia, 'desligado'>, number> = {
  equilibrado: 6,
  agressivo: 4,
};
const BUSCAS = new Set(['Read', 'Grep', 'Glob']);

interface SaidaDoBash {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

interface SaidaDoRead {
  readonly type?: unknown;
  readonly file?: { readonly content?: unknown };
}

function digital(valor: unknown): string {
  // Num array, até `undefined` vira texto.
  return createHash('sha1')
    .update(JSON.stringify([valor]))
    .digest('hex');
}

function tamanho(valor: unknown): number {
  return (JSON.stringify(valor) as string | undefined)?.length ?? 0;
}

function aviso(texto: string): string {
  return `[FaKL economia: ${texto}]`;
}

/** Troca o texto principal da saída de Bash ou Read, mantendo o formato que o Claude Code espera. */
function comTexto(ferramenta: string, resposta: unknown, texto: string): unknown {
  if (ferramenta === 'Bash') return { ...(resposta as object), stdout: texto, stderr: '' };
  const read = resposta as SaidaDoRead;
  return { ...read, file: { ...read.file, content: texto } };
}

function lembrarVisto(estado: EstadoDoGancho, chave: string, valor: string): void {
  // A mais recente vai para o fim; as mais velhas saem quando passa do limite.
  const entradas = Object.entries(estado.vistos).filter(([k]) => k !== chave);
  entradas.push([chave, valor]);
  estado.vistos = Object.fromEntries(entradas.slice(-VISTOS_MAX));
}

function posFerramenta(
  entrada: EntradaDoGancho,
  estado: EstadoDoGancho,
  config: ConfigDoGancho,
): ResultadoDoGancho {
  const modo = config.modo;
  if (modo === 'desligado') return {};
  const ferramenta = entrada.tool_name ?? '';
  const principal = entrada.agent_id === undefined;
  let resposta = entrada.tool_response;
  let mudou = false;
  const notas: string[] = [];

  if (ferramenta === 'Bash' && resposta && typeof resposta === 'object') {
    const bash = resposta as SaidaDoBash;
    const antes = tamanho(resposta);
    const stdout =
      typeof bash.stdout === 'string' ? compactarSaida(bash.stdout, modo) : bash.stdout;
    const stderr =
      typeof bash.stderr === 'string' ? compactarSaida(bash.stderr, modo) : bash.stderr;
    if (stdout !== bash.stdout || stderr !== bash.stderr) {
      resposta = { ...bash, stdout, stderr };
      const economizados = Math.max(0, antes - tamanho(resposta));
      if (economizados > 0) {
        mudou = true;
        estado.somas.respostas += 1;
        estado.somas.caracteresCompactados += economizados;
      }
    }
  }

  const leitura =
    ferramenta === 'Bash' ||
    (ferramenta === 'Read' && (resposta as SaidaDoRead | undefined)?.type === 'text');
  if (leitura && resposta && typeof resposta === 'object') {
    // O mesmo pedido, de quem tem o mesmo contexto, com exatamente a mesma saída.
    // No Bash, só o comando: a descrição muda de uma chamada para outra.
    const pedido =
      ferramenta === 'Bash'
        ? (entrada.tool_input as { command?: unknown } | undefined)?.command
        : entrada.tool_input;
    const chave = digital([entrada.agent_id ?? '', ferramenta, pedido]);
    const marca = digital(resposta);
    const repetida = estado.vistos[chave] === marca;
    lembrarVisto(estado, chave, marca);
    const atual = tamanho(resposta);
    if (repetida && atual >= REPETIDA_MIN) {
      const texto = aviso(
        l10n.t(
          'same output as the identical {0} call earlier in this conversation ({1} characters), which is still above; nothing changed since. Look there instead of running it again.',
          ferramenta,
          String(atual),
        ),
      );
      resposta = comTexto(ferramenta, resposta, texto);
      mudou = true;
      estado.somas.repeticoes += 1;
      estado.somas.caracteresRepeticoes += Math.max(0, atual - texto.length);
    }
  }

  if (principal && config.explorador && BUSCAS.has(ferramenta)) {
    estado.exploracao += 1;
    const limite = EXPLORACAO[modo];
    if (estado.exploracao % limite === 0) {
      notas.push(
        aviso(
          l10n.t(
            'this conversation has made {0} reads and searches in this turn, and each one stays in the context paid on every step. To keep exploring the code, hand the question to the `{1}` subagent (Task tool): it runs on a cheaper model and brings back only the answer.',
            String(estado.exploracao),
            config.explorador,
          ),
        ),
      );
    }
  }

  if (!mudou && notas.length === 0) return {};
  return {
    saida: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        ...(mudou ? { updatedToolOutput: resposta } : {}),
        ...(notas.length > 0 ? { additionalContext: notas.join('\n') } : {}),
      },
    },
  };
}

/** Uma chamada do gancho: muda o estado e diz o que escrever e o que registrar. */
export function processarGancho(
  entrada: EntradaDoGancho,
  estado: EstadoDoGancho,
  config: ConfigDoGancho,
): ResultadoDoGancho {
  switch (entrada.hook_event_name) {
    case 'PostToolUse':
      return posFerramenta(entrada, estado, config);
    case 'UserPromptSubmit':
      estado.exploracao = 0;
      return {};
    case 'PreCompact':
      // Depois de compactar, a saída de antes não está mais na conversa.
      estado.vistos = {};
      return {};
    case 'Stop':
    case 'SessionEnd': {
      const somas = estado.somas;
      estado.somas = { ...ZERO };
      const algo = Object.values(somas).some((valor) => valor > 0);
      return algo ? { registrar: somas } : {};
    }
    default:
      return {};
  }
}

/** Eventos que o gancho escuta, no formato de `settings.hooks` do Claude Code. */
export function ganchosDaEconomia(comando: string): Record<string, unknown> {
  const entrada = (matcher?: string): unknown[] => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: comando, timeout: 20 }],
    },
  ];
  return {
    PostToolUse: entrada('Bash|Read|Grep|Glob'),
    UserPromptSubmit: entrada(),
    PreCompact: entrada(),
    Stop: entrada(),
    SessionEnd: entrada(),
  };
}

/** Aspas simples do sh: o caminho do pipe no Windows tem barras invertidas. */
export function aspasSh(valor: string): string {
  return `'${valor.replace(/'/g, `'\\''`)}'`;
}
