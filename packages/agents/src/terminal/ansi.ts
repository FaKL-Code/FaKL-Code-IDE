/**
 * Saída de terminal para linhas de texto (ADR 0047). Um programa interativo
 * escreve escapes de cor, move o cursor e redesenha a linha com `\r`; o Core só
 * quer o texto que ficou na tela. O parser aqui é deliberadamente simples:
 * entende cor e controle como "sem texto", `\r` e `\b` como cursor na linha e
 * ignora movimentos verticais. É uma aproximação do que o usuário vê, não um
 * emulador de terminal.
 */

/** Uma linha mais longa que isto é quebrada, para um programa sem quebra de linha não encher a memória. */
export const LINE_MAX_CHARS = 2_000;

/** Tira escapes ANSI (CSI, OSC, DCS e escapes de dois caracteres) e controles, sem tratar cursor. */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC e DCS terminam em BEL ou ST (ESC \).
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[\]P^_X][\s\S]*?(?:\u0007|\u001b\\)/g, '')
      // CSI: ESC [ parâmetros, intermediários e um byte final.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // Demais escapes de dois caracteres (ESC 7, ESC =, ESC c).
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_0-9=>]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0007\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, '')
  );
}

type Mode = 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'two';

/**
 * Monta linhas a partir de pedaços que chegam em qualquer corte, inclusive no
 * meio de um escape. `push` devolve as linhas que fecharam; `partial` é a linha
 * ainda aberta (onde costuma ficar o prompt).
 */
export class LineAssembler {
  private mode: Mode = 'text';
  private line: string[] = [];
  private column = 0;
  private csiParams = '';

  /** A linha em andamento, como aparece na tela agora. */
  get partial(): string {
    return this.line.join('').replace(/\s+$/, '');
  }

  push(chunk: string): string[] {
    const done: string[] = [];
    for (const ch of chunk) this.feed(ch, done);
    return done;
  }

  /** Fecha a linha em andamento (por silêncio, por exemplo) e a devolve, se tinha texto. */
  flush(): string | undefined {
    const text = this.partial;
    this.line = [];
    this.column = 0;
    return text === '' ? undefined : text;
  }

  private feed(ch: string, done: string[]): void {
    switch (this.mode) {
      case 'esc':
        this.afterEsc(ch);
        return;
      case 'csi':
        if (ch >= '@' && ch <= '~') {
          this.endCsi(ch);
          this.mode = 'text';
        } else {
          this.csiParams += ch;
        }
        return;
      case 'osc':
        if (ch === '\u0007') this.mode = 'text';
        else if (ch === '\u001b') this.mode = 'oscEsc';
        return;
      case 'oscEsc':
        this.mode = ch === '\\' ? 'text' : 'osc';
        return;
      case 'two':
        // ESC ( B e similares: um caractere de seleção de conjunto ainda falta.
        this.mode = 'text';
        return;
      default:
        break;
    }
    if (ch === '\u001b') {
      this.mode = 'esc';
    } else if (ch === '\n') {
      done.push(this.close());
    } else if (ch === '\r') {
      this.column = 0;
    } else if (ch === '\b') {
      this.column = Math.max(0, this.column - 1);
    } else if (ch === '\t') {
      this.write(' ');
    } else if (ch >= ' ' && !(ch >= '\u007f' && ch <= '\u009f')) {
      this.write(ch);
      if (this.line.length >= LINE_MAX_CHARS) done.push(this.close());
    }
  }

  private afterEsc(ch: string): void {
    if (ch === '[') {
      this.mode = 'csi';
      this.csiParams = '';
    } else if (ch === ']' || ch === 'P' || ch === '^' || ch === '_' || ch === 'X') {
      this.mode = 'osc';
    } else if ('()*+-./#%'.includes(ch)) {
      this.mode = 'two';
    } else {
      this.mode = 'text';
    }
  }

  /** Só o apagamento da linha e o movimento horizontal mexem no texto; o resto é só visual. */
  private endCsi(final: string): void {
    const n = Number.parseInt(this.csiParams.replace(/[^0-9;]/g, '').split(';')[0] ?? '', 10);
    if (final === 'K') {
      const mode = Number.isNaN(n) ? 0 : n;
      if (mode === 2) {
        this.line = [];
        this.column = 0;
      } else if (mode === 0) {
        this.line.length = Math.min(this.line.length, this.column);
      } else {
        for (let i = 0; i < this.column && i < this.line.length; i++) this.line[i] = ' ';
      }
    } else if (final === 'G') {
      this.column = Math.max(0, (Number.isNaN(n) ? 1 : n) - 1);
    } else if (final === 'C') {
      this.column += Number.isNaN(n) ? 1 : n;
    } else if (final === 'D') {
      this.column = Math.max(0, this.column - (Number.isNaN(n) ? 1 : n));
    } else if (final === 'H' || final === 'f') {
      // Posição absoluta: a tela foi redesenhada; recomeça a linha.
      this.column = 0;
    }
  }

  private write(ch: string): void {
    while (this.line.length < this.column) this.line.push(' ');
    this.line[this.column] = ch;
    this.column++;
  }

  private close(): string {
    const text = this.partial;
    this.line = [];
    this.column = 0;
    return text;
  }
}
