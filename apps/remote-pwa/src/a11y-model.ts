import { l10n } from '@fakl/i18n';

import type { Conexao } from './app.js';

/*
 * Textos e ritmo dos anúncios do app para leitor de tela (RNF-14). Lógica pura,
 * sem DOM: a casca chama `push` quando algo muda e escreve na região
 * `aria-live=polite` o que `take` devolver.
 */

/** Frase para quando chegam pedidos e decisões; só avisa se a fila cresceu. */
export function pendingAnnouncement(before: number, after: number): string | undefined {
  if (after <= before) return undefined;
  return after === 1
    ? l10n.t('1 item is waiting for you')
    : l10n.t('{0} items are waiting for you', String(after));
}

/** Frase para quando a conexão com a IDE muda; `conectando` não é dito, para não repetir a cada tentativa. */
export function connectionAnnouncement(before: Conexao, after: Conexao): string | undefined {
  if (before === after) return undefined;
  if (after === 'online') return l10n.t('Connected to the IDE');
  if (after === 'offline') return l10n.t('Disconnected from the IDE');
  return undefined;
}

/** Nome acessível da aba: o rótulo e, se houver, quantos esperam. */
export function tabLabel(label: string, pending: number): string {
  return pending > 0 ? l10n.t('{0}, {1} pending', label, String(pending)) : label;
}

/**
 * Fila dos anúncios com intervalo mínimo. Cada canal ("fila", "conexão") guarda
 * só a última frase, e o que sai junto é lido numa frase só.
 */
export class AnnouncementLimiter {
  private readonly pending = new Map<string, string>();
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minIntervalMs = 3_000) {}

  push(channel: string, text: string | undefined): void {
    if (text === undefined) return;
    // Reinserir move o canal para o fim: a ordem de saída é a da última novidade.
    this.pending.delete(channel);
    this.pending.set(channel, text);
  }

  /** Milissegundos até poder falar; `undefined` se não há nada a dizer. */
  waitMs(now: number): number | undefined {
    if (this.pending.size === 0) return undefined;
    return Math.max(0, this.lastAt + this.minIntervalMs - now);
  }

  take(now: number): string | undefined {
    if (this.pending.size === 0 || now - this.lastAt < this.minIntervalMs) return undefined;
    const text = [...this.pending.values()].join('. ');
    this.pending.clear();
    this.lastAt = now;
    return text;
  }
}
