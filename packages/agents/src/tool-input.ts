import { createHash } from 'node:crypto';

/**
 * Impressão digital dos argumentos de uma chamada (`rawInput`), para o freio
 * separar cinco edições diferentes do mesmo arquivo de cinco edições iguais.
 * As chaves vão em ordem; sem argumentos, nada.
 */
export function toolInputKey(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) {
    return undefined;
  }
  const json = JSON.stringify(input, (_, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return createHash('sha1').update(json).digest('hex').slice(0, 16);
}
