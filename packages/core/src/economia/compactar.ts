/**
 * Compactação das respostas das ferramentas MCP (ADR 0052). A resposta que o
 * agente recebe vira contexto pago a cada rodada, então tirar o que não
 * informa (indentação do JSON, cores ANSI, linhas repetidas, trechos enormes)
 * reduz o custo sem mudar o que a ferramenta diz.
 */

export type ModoEconomia = 'desligado' | 'equilibrado' | 'agressivo';
export const MODOS_ECONOMIA: readonly ModoEconomia[] = ['desligado', 'equilibrado', 'agressivo'];

export function isModoEconomia(value: unknown): value is ModoEconomia {
  return typeof value === 'string' && (MODOS_ECONOMIA as readonly string[]).includes(value);
}

/** Estimativa usual de tokens: um token para cada 4 caracteres. É uma estimativa, não uma medição. */
export function estimarTokens(caracteres: number): number {
  return Math.round(caracteres / 4);
}

interface Limites {
  /** Texto maior que isso é cortado no meio. */
  readonly textoMax: number;
  /** Repetições seguidas da mesma linha viram uma só com contagem a partir daqui. */
  readonly repeticoesMin: number;
  /** Tira `null`, texto vazio e lista vazia dos objetos. */
  readonly podarVazios: boolean;
}

const LIMITES: Record<Exclude<ModoEconomia, 'desligado'>, Limites> = {
  equilibrado: { textoMax: 12_000, repeticoesMin: 3, podarVazios: false },
  agressivo: { textoMax: 5_000, repeticoesMin: 2, podarVazios: true },
};

// eslint-disable-next-line no-control-regex -- sequências de escape do terminal
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function tirarAnsi(texto: string): string {
  return texto.replace(ANSI, '');
}

/** Junta linhas iguais e seguidas: a linha e `[linha acima repetida 40 vezes]`. */
export function juntarRepetidas(texto: string, minimo: number): string {
  const linhas = texto.split('\n');
  const saida: string[] = [];
  for (let i = 0; i < linhas.length;) {
    const linha = linhas[i] ?? '';
    let j = i + 1;
    while (j < linhas.length && linhas[j] === linha) j += 1;
    const vezes = j - i;
    if (vezes >= minimo && linha.trim() !== '') {
      saida.push(linha, `[linha acima repetida ${String(vezes)} vezes]`);
    } else {
      for (let k = 0; k < vezes; k += 1) saida.push(linha);
    }
    i = j;
  }
  return saida.join('\n');
}

/**
 * Corta o meio do texto, guardando o começo (60%) e o fim (40%): num log, o
 * erro costuma estar no fim e o contexto no começo.
 */
export function cortarMeio(texto: string, max: number): string {
  if (texto.length <= max) return texto;
  const inicio = Math.floor(max * 0.6);
  const fim = max - inicio;
  const omitidos = texto.length - inicio - fim;
  return `${texto.slice(0, inicio)}\n[... ${String(omitidos)} caracteres omitidos; peça um trecho menor se precisar ...]\n${texto.slice(texto.length - fim)}`;
}

function compactarTexto(texto: string, limites: Limites): string {
  return cortarMeio(juntarRepetidas(tirarAnsi(texto), limites.repeticoesMin), limites.textoMax);
}

/** Compacta um texto solto (a saída de um comando) pelos limites do modo. */
export function compactarSaida(texto: string, modo: ModoEconomia): string {
  return modo === 'desligado' ? texto : compactarTexto(texto, LIMITES[modo]);
}

function vazio(valor: unknown): boolean {
  return valor === null || valor === '' || (Array.isArray(valor) && valor.length === 0);
}

function compactarValor(valor: unknown, limites: Limites): unknown {
  if (typeof valor === 'string') return compactarTexto(valor, limites);
  if (Array.isArray(valor)) return valor.map((item) => compactarValor(item, limites));
  if (valor !== null && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor)) {
      if (limites.podarVazios && vazio(item)) continue;
      saida[chave] = compactarValor(item, limites);
    }
    return saida;
  }
  return valor;
}

export interface Compactado {
  /** Texto que vai ao agente. */
  readonly texto: string;
  /** O valor já compactado, para `structuredContent`. */
  readonly valor: unknown;
  /** Caracteres a menos em relação ao JSON indentado de antes. */
  readonly economizados: number;
}

/**
 * Compacta o resultado de uma ferramenta. Sem economia (`desligado`) devolve o
 * mesmo JSON indentado de sempre.
 */
export function compactarResultado(resultado: unknown, modo: ModoEconomia): Compactado {
  const base = (JSON.stringify(resultado, null, 2) as string | undefined) ?? 'null';
  if (modo === 'desligado') return { texto: base, valor: resultado, economizados: 0 };
  const valor = compactarValor(resultado, LIMITES[modo]);
  const texto = (JSON.stringify(valor) as string | undefined) ?? 'null';
  return { texto, valor, economizados: Math.max(0, base.length - texto.length) };
}
