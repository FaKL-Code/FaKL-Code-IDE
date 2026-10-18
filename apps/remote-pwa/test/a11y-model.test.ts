import { useLocale } from '@fakl/i18n';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AnnouncementLimiter,
  connectionAnnouncement,
  pendingAnnouncement,
  tabLabel,
} from '../src/a11y-model.js';

beforeEach(() => {
  useLocale('en');
});

describe('pendingAnnouncement', () => {
  it('só avisa quando a fila cresce', () => {
    expect(pendingAnnouncement(0, 1)).toBe('1 item is waiting for you');
    expect(pendingAnnouncement(1, 3)).toBe('3 items are waiting for you');
    expect(pendingAnnouncement(3, 3)).toBeUndefined();
    expect(pendingAnnouncement(3, 1)).toBeUndefined();
    expect(pendingAnnouncement(1, 0)).toBeUndefined();
  });
});

describe('connectionAnnouncement', () => {
  it('diz ao conectar e ao cair, e cala nas tentativas', () => {
    expect(connectionAnnouncement('conectando', 'online')).toBe('Connected to the IDE');
    expect(connectionAnnouncement('online', 'offline')).toBe('Disconnected from the IDE');
    expect(connectionAnnouncement('offline', 'conectando')).toBeUndefined();
    expect(connectionAnnouncement('online', 'online')).toBeUndefined();
  });
});

describe('tabLabel', () => {
  it('junta o rótulo e a contagem', () => {
    expect(tabLabel('Inbox', 0)).toBe('Inbox');
    expect(tabLabel('Inbox', 2)).toBe('Inbox, 2 pending');
  });
});

describe('AnnouncementLimiter', () => {
  it('fala na hora e depois só após o intervalo', () => {
    const limiter = new AnnouncementLimiter(3_000);
    limiter.push('fila', 'one');
    expect(limiter.take(0)).toBe('one');
    limiter.push('fila', 'two');
    expect(limiter.waitMs(1_000)).toBe(2_000);
    expect(limiter.take(1_000)).toBeUndefined();
    expect(limiter.take(3_000)).toBe('two');
  });

  it('cada canal guarda só a última frase e o que sai junto vira uma frase', () => {
    const limiter = new AnnouncementLimiter();
    limiter.push('fila', '1 item');
    limiter.push('conexao', 'Disconnected');
    limiter.push('fila', '2 items');
    expect(limiter.take(0)).toBe('Disconnected. 2 items');
  });

  it('ignora frase vazia e não tem espera sem pendência', () => {
    const limiter = new AnnouncementLimiter();
    limiter.push('fila', undefined);
    expect(limiter.waitMs(0)).toBeUndefined();
    expect(limiter.take(0)).toBeUndefined();
  });
});
