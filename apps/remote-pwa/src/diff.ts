import { l10n } from '@fakl/i18n';

/** Uma linha do diff mostrado no celular. */
export interface DiffLine {
  readonly tipo: 'igual' | 'mais' | 'menos' | 'pulo';
  readonly texto: string;
}

const MAX_CELLS = 4_000_000;

/**
 * Diff por linhas (LCS) com contexto, para arquivos de código comuns. Arquivos
 * grandes demais para a tabela viram "removido tudo, adicionado tudo".
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffLine[] = a.slice(0, start).map((texto) => ({ tipo: 'igual', texto }));
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    ops.push(...midA.map((texto): DiffLine => ({ tipo: 'menos', texto })));
    ops.push(...midB.map((texto): DiffLine => ({ tipo: 'mais', texto })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ tipo: 'igual', texto: midA[i] ?? '' });
        i++;
        j++;
      } else if (
        i < n &&
        (j >= m || (table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0))
      ) {
        // Num empate, o que saiu vem antes do que entrou, como no git.
        ops.push({ tipo: 'menos', texto: midA[i] ?? '' });
        i++;
      } else {
        ops.push({ tipo: 'mais', texto: midB[j] ?? '' });
        j++;
      }
    }
  }
  ops.push(...a.slice(endA).map((texto): DiffLine => ({ tipo: 'igual', texto })));

  // Só o contexto em volta das mudanças.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.tipo === 'igual') return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(ops.length - 1, index + context);
      k++
    ) {
      keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ tipo: 'pulo', texto: unchanged(skipped) });
      skipped = 0;
      out.push(op);
    } else {
      skipped++;
    }
  });
  if (skipped > 0 && out.length > 0) out.push({ tipo: 'pulo', texto: unchanged(skipped) });
  return out;
}

/** Texto do trecho pulado: "3 linhas iguais". */
function unchanged(count: number): string {
  return count === 1 ? l10n.t('1 unchanged line') : l10n.t('{0} unchanged lines', count);
}
