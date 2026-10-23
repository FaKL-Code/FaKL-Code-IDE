import { l10n } from '@fakl/i18n';

/**
 * Freio do agente: um agente que não acha a resposta pode ficar horas chamando
 * ferramentas, e cada passo reenvia o contexto inteiro ao modelo (milhões de
 * tokens de entrada para uma pergunta simples). O freio conta o que acontece
 * numa rodada e manda pausar antes disso virar conta. Zero desliga o limite.
 */
export interface FreioConfig {
  /**
   * Tokens de entrada da rodada, em equivalente de preço: o que o contexto cresceu
   * conta inteiro e o começo repetido, que vem do cache, conta um décimo.
   */
  readonly tokens: number;
  /** Chamadas de ferramenta na rodada. */
  readonly passos: number;
  /** A mesma chamada de ferramenta, uma atrás da outra. */
  readonly repeticoes: number;
}

export const FREIO_PADRAO: FreioConfig = { tokens: 1_500_000, passos: 60, repeticoes: 5 };

/** Quanto um token lido do cache pesa perto de um token novo (preço da Anthropic). */
const PESO_DO_CACHE = 0.1;

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
  /** Contexto da requisição anterior, que segue entre rodadas: é o prefixo no cache. */
  private prefixo = 0;
  private ultima = '';
  private seguidas = 0;
  private readonly vistos = new Set<string>();
  /** A última chamada contada e a sequência de antes dela, para refazer com o título completo. */
  private atual = '';
  private atualTitulo = '';
  private atualEntrada = '';
  private antes = { ultima: '', seguidas: 0 };
  private parou = false;

  constructor(private readonly config: () => FreioConfig = () => FREIO_PADRAO) {}

  iniciar(): void {
    this.passos = 0;
    this.entrada = 0;
    this.ultimoContexto = -1;
    this.ultima = '';
    this.seguidas = 0;
    this.vistos.clear();
    this.atual = '';
    this.atualTitulo = '';
    this.atualEntrada = '';
    this.antes = { ultima: '', seguidas: 0 };
    this.parou = false;
  }

  gasto(): GastoDaRodada {
    return { passos: this.passos, entrada: this.entrada };
  }

  /**
   * Um evento de ferramenta. A mesma chamada é o mesmo título com os mesmos
   * argumentos (`entrada`, a impressão digital deles): cinco edições diferentes
   * do mesmo arquivo têm o mesmo título e não são um loop. O passo conta no
   * primeiro evento do `toolCallId`; a repetição usa o que chegou de mais
   * completo, porque o ACP manda primeiro um título genérico ("Terminal") e o
   * comando e os argumentos só num update da mesma chamada.
   */
  ferramenta(id: string, titulo: string | undefined, entrada?: string): Parada | undefined {
    if (this.vistos.has(id)) {
      if (id !== this.atual) return undefined;
      // Vazio não apaga o que já chegou.
      const limpo = titulo?.trim();
      if (limpo) this.atualTitulo = limpo;
      if (entrada) this.atualEntrada = entrada;
      const assinatura = this.assinatura();
      if (this.atualTitulo === '' || assinatura === this.ultima) return undefined;
      this.ultima = this.antes.ultima;
      this.seguidas = this.antes.seguidas;
      return this.repeticao(assinatura);
    }
    this.vistos.add(id);
    this.passos += 1;
    this.atual = id;
    this.atualTitulo = titulo?.trim() ?? '';
    this.atualEntrada = entrada ?? '';
    this.antes = { ultima: this.ultima, seguidas: this.seguidas };
    const repetiu = this.repeticao(this.assinatura());
    if (repetiu) return repetiu;
    const { passos } = this.config();
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

  private assinatura(): string {
    if (this.atualTitulo === '') return '';
    return this.atualEntrada ? `${this.atualTitulo}\u0000${this.atualEntrada}` : this.atualTitulo;
  }

  private repeticao(assinatura: string): Parada | undefined {
    if (assinatura !== '' && assinatura === this.ultima) this.seguidas += 1;
    else {
      this.ultima = assinatura;
      this.seguidas = 1;
    }
    const { repeticoes } = this.config();
    if (repeticoes > 0 && this.seguidas >= repeticoes) {
      return this.parar({
        motivo: 'repeticao',
        mensagem: l10n.t(
          'Paused: the agent called the same tool {0} times in a row ({1}). It may be stuck in a loop.',
          String(this.seguidas),
          this.atualTitulo,
        ),
      });
    }
    return undefined;
  }

  /**
   * O contexto que o agente informa a cada requisição (ACP `usage_update`).
   * Cada requisição reenvia o contexto inteiro, mas o começo dele é o da
   * anterior e sai do cache por um décimo do preço: somar o contexto cheio
   * parava em 20 passos um maestro que trabalhava normalmente.
   */
  contexto(usado: number): Parada | undefined {
    if (usado <= 0 || usado === this.ultimoContexto) return undefined;
    this.ultimoContexto = usado;
    // Compactado, o contexto encolhe e o que sobrou é novo para o cache.
    const cache = usado >= this.prefixo ? this.prefixo : 0;
    this.prefixo = usado;
    this.entrada += Math.round(usado - cache + cache * PESO_DO_CACHE);
    const { tokens } = this.config();
    if (tokens > 0 && this.entrada >= tokens) {
      return this.parar({
        motivo: 'tokens',
        mensagem: l10n.t(
          'Paused: this turn has already sent the equivalent of about {0} input tokens to the model (cache reads count as a tenth).',
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
