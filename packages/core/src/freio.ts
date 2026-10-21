import { l10n } from '@fakl/i18n';

/**
 * Freio do agente: um agente que não acha a resposta pode ficar horas chamando
 * ferramentas, e cada passo reenvia o contexto inteiro ao modelo (milhões de
 * tokens de entrada para uma pergunta simples). O freio conta o que acontece
 * numa rodada e manda pausar antes disso virar conta. Zero desliga o limite.
 */
export interface FreioConfig {
  /** Tokens de entrada estimados na rodada (soma do contexto de cada requisição). */
  readonly tokens: number;
  /** Chamadas de ferramenta na rodada. */
  readonly passos: number;
  /** A mesma chamada de ferramenta, uma atrás da outra. */
  readonly repeticoes: number;
}

export const FREIO_PADRAO: FreioConfig = { tokens: 1_500_000, passos: 60, repeticoes: 5 };

export type MotivoDoFreio = 'tokens' | 'passos' | 'repeticao';

export interface Parada {
  readonly motivo: MotivoDoFreio;
  /** Texto para a pessoa, já traduzido. */
  readonly mensagem: string;
}

/** O que a rodada gastou até agora; aparece na sessão. */
export interface GastoDaRodada {
  readonly passos: number;
  readonly entrada: number;
}

function formatar(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, '.');
}

/** Conta uma rodada de um agente. `iniciar` zera; o Core chama no começo de cada rodada. */
export class FreioDaRodada {
  private passos = 0;
  private entrada = 0;
  private ultimoContexto = -1;
  private ultima = '';
  private seguidas = 0;
  private readonly vistos = new Set<string>();
  private parou = false;

  constructor(private readonly config: () => FreioConfig = () => FREIO_PADRAO) {}

  iniciar(): void {
    this.passos = 0;
    this.entrada = 0;
    this.ultimoContexto = -1;
    this.ultima = '';
    this.seguidas = 0;
    this.vistos.clear();
    this.parou = false;
  }

  gasto(): GastoDaRodada {
    return { passos: this.passos, entrada: this.entrada };
  }

  /**
   * Uma chamada de ferramenta nova (`toolCallId` ainda não visto). O título
   * costuma trazer os argumentos, então o mesmo título é a mesma chamada.
   */
  ferramenta(id: string, titulo: string | undefined): Parada | undefined {
    if (this.vistos.has(id)) return undefined;
    this.vistos.add(id);
    this.passos += 1;
    const assinatura = (titulo ?? '').trim();
    if (assinatura !== '' && assinatura === this.ultima) this.seguidas += 1;
    else {
      this.ultima = assinatura;
      this.seguidas = 1;
    }
    const { passos, repeticoes } = this.config();
    if (repeticoes > 0 && this.seguidas >= repeticoes) {
      return this.parar({
        motivo: 'repeticao',
        mensagem: l10n.t(
          'Paused: the agent called the same tool {0} times in a row ({1}). It may be stuck in a loop.',
          String(this.seguidas),
          assinatura,
        ),
      });
    }
    if (passos > 0 && this.passos >= passos) {
      return this.parar({
        motivo: 'passos',
        mensagem: l10n.t(
          'Paused: the agent has made {0} tool calls in this turn without finishing.',
          String(this.passos),
        ),
      });
    }
    return undefined;
  }

  /**
   * O contexto que o agente informa a cada requisição (ACP `usage_update`):
   * cada requisição reenvia o contexto inteiro, então a soma deles é a entrada.
   */
  contexto(usado: number): Parada | undefined {
    if (usado <= 0 || usado === this.ultimoContexto) return undefined;
    this.ultimoContexto = usado;
    this.entrada += usado;
    const { tokens } = this.config();
    if (tokens > 0 && this.entrada >= tokens) {
      return this.parar({
        motivo: 'tokens',
        mensagem: l10n.t(
          'Paused: this turn has already sent about {0} input tokens to the model.',
          formatar(this.entrada),
        ),
      });
    }
    return undefined;
  }

  /** Só uma parada por rodada: depois de avisar, o resto da rodada cancelada é ignorado. */
  private parar(parada: Parada): Parada | undefined {
    if (this.parou) return undefined;
    this.parou = true;
    return parada;
  }
}
