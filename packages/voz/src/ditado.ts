/**
 * Ditado em pt-BR: troca as palavras de pontuação faladas ("vírgula",
 * "ponto final", "nova linha", "abre parênteses"...) pelos sinais, ajusta
 * espaços e maiúsculas depois de ponto e tira espaços sobrando.
 *
 * A detecção ignora caixa e acento. Regras que evitam estragar texto que só
 * menciona a palavra:
 * - "ponto" sozinho só vira "." quando é a última palavra, vem antes de
 *   "final" ou antes de uma quebra de linha/parágrafo; "ponto de venda" e
 *   "o ponto é simples" ficam como estão;
 * - "dois pontos" sempre vira ":" e "hífen" sempre vira "-" (sem espaços);
 *   "travessão" vira "—" com espaço dos dois lados.
 */

type Peca =
  /** Palavra comum; pode já trazer pontuação colada. */
  | { readonly tipo: 'palavra'; readonly texto: string }
  /** Sinal que gruda na palavra anterior e leva um espaço depois. */
  | { readonly tipo: 'fecha'; readonly texto: string }
  /** Sinal que leva espaço antes e gruda na palavra seguinte. */
  | { readonly tipo: 'abre'; readonly texto: string }
  /** Hífen: gruda dos dois lados. */
  | { readonly tipo: 'hifen' }
  | { readonly tipo: 'quebra'; readonly texto: string };

interface Frase {
  readonly palavras: readonly string[];
  readonly peca: Peca;
  /** Só vale se a frase for a última do texto, ou vier antes de "final"/quebra. */
  readonly soNoFim?: true;
}

const FRASES: readonly Frase[] = [
  { palavras: ['ponto', 'de', 'interrogacao'], peca: { tipo: 'fecha', texto: '?' } },
  { palavras: ['ponto', 'de', 'exclamacao'], peca: { tipo: 'fecha', texto: '!' } },
  { palavras: ['ponto', 'e', 'virgula'], peca: { tipo: 'fecha', texto: ';' } },
  { palavras: ['ponto', 'final'], peca: { tipo: 'fecha', texto: '.' } },
  { palavras: ['dois', 'pontos'], peca: { tipo: 'fecha', texto: ':' } },
  { palavras: ['virgula'], peca: { tipo: 'fecha', texto: ',' } },
  { palavras: ['nova', 'linha'], peca: { tipo: 'quebra', texto: '\n' } },
  { palavras: ['proxima', 'linha'], peca: { tipo: 'quebra', texto: '\n' } },
  { palavras: ['novo', 'paragrafo'], peca: { tipo: 'quebra', texto: '\n\n' } },
  { palavras: ['abre', 'parenteses'], peca: { tipo: 'abre', texto: '(' } },
  { palavras: ['abrir', 'parenteses'], peca: { tipo: 'abre', texto: '(' } },
  { palavras: ['abre', 'parentese'], peca: { tipo: 'abre', texto: '(' } },
  { palavras: ['fecha', 'parenteses'], peca: { tipo: 'fecha', texto: ')' } },
  { palavras: ['fechar', 'parenteses'], peca: { tipo: 'fecha', texto: ')' } },
  { palavras: ['fecha', 'parentese'], peca: { tipo: 'fecha', texto: ')' } },
  { palavras: ['abre', 'aspas'], peca: { tipo: 'abre', texto: '"' } },
  { palavras: ['abrir', 'aspas'], peca: { tipo: 'abre', texto: '"' } },
  { palavras: ['fecha', 'aspas'], peca: { tipo: 'fecha', texto: '"' } },
  { palavras: ['fechar', 'aspas'], peca: { tipo: 'fecha', texto: '"' } },
  { palavras: ['hifen'], peca: { tipo: 'hifen' } },
  { palavras: ['travessao'], peca: { tipo: 'palavra', texto: '—' } },
  { palavras: ['ponto'], peca: { tipo: 'fecha', texto: '.' }, soNoFim: true },
];

function semAcento(palavra: string): string {
  return palavra.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function ehQuebra(token: string): boolean {
  return /^\n+$/.test(token);
}

/** Pode um "ponto" sozinho virar "." aqui? Só no fim, antes de "final" ou de quebra. */
function pontoValeComoSinal(tokens: readonly string[], seguinte: number): boolean {
  const proximo = tokens[seguinte];
  if (proximo === undefined || ehQuebra(proximo)) return true;
  const chave = semAcento(proximo);
  if (chave === 'final') return true;
  return FRASES.some(
    (f) =>
      f.peca.tipo === 'quebra' &&
      f.palavras.every((p, k) => semAcento(tokens[seguinte + k] ?? '') === p),
  );
}

function tokenizar(texto: string): string[] {
  return texto
    .replace(/\r/g, '')
    .replace(/[ \t]*(\n+)[ \t]*/g, ' $1 ')
    .split(/[ \t]+/)
    .filter((t) => t !== '');
}

function reconhecer(tokens: readonly string[]): Peca[] {
  const chaves = tokens.map(semAcento);
  const pecas: Peca[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    const achada = FRASES.find(
      (f) =>
        f.palavras.every((p, k) => chaves[i + k] === p) &&
        (f.soNoFim === undefined || pontoValeComoSinal(tokens, i + f.palavras.length)),
    );
    if (achada) {
      pecas.push(achada.peca);
      i += achada.palavras.length;
    } else if (ehQuebra(token)) {
      pecas.push({ tipo: 'quebra', texto: token });
      i += 1;
    } else if (/^[,.;:?!)]+$/.test(token)) {
      pecas.push({ tipo: 'fecha', texto: token });
      i += 1;
    } else if (/^[("]$/.test(token)) {
      pecas.push({ tipo: 'abre', texto: token });
      i += 1;
    } else {
      pecas.push({ tipo: 'palavra', texto: token });
      i += 1;
    }
  }
  return pecas;
}

function montar(pecas: readonly Peca[]): string {
  let saida = '';
  /** O próximo item gruda no que já está escrito (depois de "(" ou de hífen). */
  let colar = true;
  for (const peca of pecas) {
    switch (peca.tipo) {
      case 'quebra':
        saida += peca.texto;
        colar = true;
        break;
      case 'fecha':
        saida += peca.texto;
        colar = false;
        break;
      case 'hifen':
        saida += '-';
        colar = true;
        break;
      case 'abre':
        saida += (colar ? '' : ' ') + peca.texto;
        colar = true;
        break;
      case 'palavra':
        saida += (colar ? '' : ' ') + peca.texto;
        colar = false;
        break;
    }
  }
  return saida;
}

function capitalizar(texto: string): string {
  return texto.replace(
    /(^|[.!?]\s+|\n)(\p{Ll})/gu,
    (_, antes: string, letra: string) => antes + letra.toUpperCase(),
  );
}

/**
 * Ditado em pt-BR: troca as palavras de pontuação faladas ("vírgula",
 * "ponto final", "nova linha", "abre parênteses"...) pelos sinais, ajusta
 * espaços e maiúsculas depois de ponto e tira espaços sobrando.
 */
export function normalizarDitado(texto: string): string {
  return capitalizar(montar(reconhecer(tokenizar(texto))));
}

/** Junta um trecho novo ao texto já ditado, com o espaço certo entre os dois. */
export function juntarDitado(anterior: string, novo: string): string {
  if (novo === '') return anterior;
  if (anterior === '' || /[\s(]$/.test(anterior)) return anterior + novo;
  if (/^[\s,.;:?!)]/.test(novo)) return anterior + novo;
  return `${anterior} ${novo}`;
}
