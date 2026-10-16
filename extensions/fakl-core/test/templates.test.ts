import { describe, expect, it } from 'vitest';

import { fillTemplate, formatDate } from '../src/templates.js';

describe('templates do vault', () => {
  const now = new Date(2026, 9, 12, 7, 5);

  it('formata datas no estilo do Obsidian', () => {
    expect(formatDate(now, 'YYYY-MM-DD HH:mm')).toBe('2026-10-12 07:05');
  });

  it('preenche título, data e hora', () => {
    expect(fillTemplate('# {{title}}\n{{date}} {{time}} {{ date:DD/MM/YYYY }}', 'Ideia', now)).toBe(
      '# Ideia\n2026-10-12 07:05 12/10/2026',
    );
  });
});
