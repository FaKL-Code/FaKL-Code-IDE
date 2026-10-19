import type { ModoEconomia } from './compactar.js';

/** Ferramentas só de leitura, que o Core atende sempre do mesmo jeito se nada mudou. */
const LEITURAS = new Set([
  'vault.search',
  'vault.semanticSearch',
  'vault.read',
  'vault.backlinks',
  'github.issues.list',
  'github.issues.get',
  'github.prs.list',
  'github.prs.get',
  'github.actions.list',
  'github.actions.logs',
  'account.repos.list',
  'resources.find',
  'resources.get',
  'maestro.listProfiles',
]);

const TTL_MS: Record<Exclude<ModoEconomia, 'desligado'>, number> = {
  equilibrado: 45_000,
  agressivo: 90_000,
};
/** Respostas menores que isso não compensam um aviso no lugar. */
const TAMANHO_MIN = 1_200;
const ENTRADAS_MAX = 200;
const PREVIA = 240;

interface Entrada {
  readonly em: number;
  readonly tamanho: number;
  readonly previa: string;
}

/**
 * Chamada repetida de uma ferramenta de leitura, com os mesmos argumentos,
 * dentro de poucos segundos: a primeira resposta ainda está na conversa do
 * agente, então a segunda vira um aviso curto em vez de pagar o mesmo texto
 * de novo. Qualquer chamada que não seja leitura (escrita, comando) limpa tudo,
 * porque pode ter mudado o que a leitura mostraria.
 */
export class DetectorDeRepeticao {
  private readonly entradas = new Map<string, Entrada>();

  constructor(
    private readonly modo: () => ModoEconomia,
    private readonly agora: () => number = Date.now,
  ) {}

  /** Antes de chamar o Core. Devolve o aviso, se for uma repetição. */
  repetida(
    metodo: string,
    args: unknown,
  ): { readonly aviso: string; readonly economizados: number } | undefined {
    const modo = this.modo();
    if (modo === 'desligado') return undefined;
    if (!LEITURAS.has(metodo)) {
      this.entradas.clear();
      return undefined;
    }
    const anterior = this.entradas.get(chave(metodo, args));
    if (!anterior || this.agora() - anterior.em > TTL_MS[modo]) return undefined;
    const segundos = Math.max(1, Math.round((this.agora() - anterior.em) / 1000));
    const aviso = `[Resultado idêntico ao da mesma chamada há ${String(segundos)}s, que já está na sua conversa. Começo dele: ${anterior.previa}]`;
    return { aviso, economizados: Math.max(0, anterior.tamanho - aviso.length) };
  }

  /** Depois de uma resposta de leitura, guarda o que for preciso para reconhecer a repetição. */
  lembrar(metodo: string, args: unknown, texto: string): void {
    if (this.modo() === 'desligado' || !LEITURAS.has(metodo) || texto.length < TAMANHO_MIN) return;
    if (this.entradas.size >= ENTRADAS_MAX) {
      const primeira = this.entradas.keys().next().value;
      if (primeira !== undefined) this.entradas.delete(primeira);
    }
    this.entradas.set(chave(metodo, args), {
      em: this.agora(),
      tamanho: texto.length,
      previa: texto.slice(0, PREVIA).replace(/\s+/g, ' '),
    });
  }
}

function chave(metodo: string, args: unknown): string {
  return `${metodo}\u0000${JSON.stringify(args ?? null)}`;
}
