import { currentLocale } from '@fakl/i18n';

/** Horário local, no idioma da IDE, sem inventar uma previsão quando o provedor não a informa. */
export function recoveryTime(retomarEm?: string): string | undefined {
  if (!retomarEm) return undefined;
  const date = new Date(retomarEm);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString(currentLocale());
}
