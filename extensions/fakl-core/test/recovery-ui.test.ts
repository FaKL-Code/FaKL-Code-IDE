import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import { recoveryTime } from '../src/recovery-ui.js';

describe('horário da retomada', () => {
  afterEach(() => useLocale('en'));

  it('não inventa uma próxima tentativa quando o horário é ausente ou inválido', () => {
    expect(recoveryTime()).toBeUndefined();
    expect(recoveryTime('')).toBeUndefined();
    expect(recoveryTime('sem previsão')).toBeUndefined();
  });

  it('apresenta a data no idioma da IDE, no fuso local', () => {
    const iso = '2026-10-15T20:00:00Z';
    expect(recoveryTime(iso)).toBe(new Date(iso).toLocaleString('en'));
    useLocale('pt-br');
    expect(recoveryTime(iso)).toBe(new Date(iso).toLocaleString('pt-BR'));
  });
});
