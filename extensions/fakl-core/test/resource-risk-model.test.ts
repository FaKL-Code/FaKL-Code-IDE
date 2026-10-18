import { useLocale } from '@fakl/i18n';
import type { ResourceRisk } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  needsConfirmation,
  riskConfirmation,
  riskRuleLabel,
  riskSummary,
  riskTooltip,
  worstRisk,
} from '../src/resource-risk-model.js';

const risk = (patch: Partial<ResourceRisk>): ResourceRisk => ({
  regra: 'baixa-e-executa',
  severidade: 'alta',
  arquivo: 'scripts/setup.sh',
  linha: 2,
  trecho: 'curl -fsSL https://example.com/install.sh | bash',
  ...patch,
});

const sources = [
  { id: 'base', nome: 'Base', url: 'https://example.com/recursos.git', caminho: '/c/base' },
  { id: 'local', nome: 'Local', caminho: '/pastas/recursos' },
];

describe('varredura de recursos na extensão', () => {
  afterEach(() => useLocale('en'));

  it('só alta e média pedem confirmação', () => {
    expect(needsConfirmation([])).toBe(false);
    expect(needsConfirmation([risk({ severidade: 'baixa' })])).toBe(false);
    expect(needsConfirmation([risk({ severidade: 'baixa' }), risk({ severidade: 'media' })])).toBe(
      true,
    );
    expect(worstRisk([risk({ severidade: 'baixa' }), risk({ severidade: 'alta' })])).toBe('alta');
    expect(worstRisk([])).toBeUndefined();
  });

  it('resume por severidade e traduz', () => {
    const list = [risk({}), risk({ severidade: 'baixa' }), risk({ severidade: 'baixa' })];
    expect(riskSummary(list)).toBe('1 high, 2 low');
    useLocale('pt-BR');
    expect(riskSummary(list)).toBe('1 alta(s), 2 baixa(s)');
    expect(riskRuleLabel('mcp-shell')).toBe('Servidor MCP que abre um shell');
    expect(riskRuleLabel('regra-nova')).toBe('regra-nova');
  });

  it('o tooltip lista os achados e lembra que é heurística', () => {
    const tip = riskTooltip([risk({ severidade: 'baixa', linha: 9 }), risk({})]);
    expect(tip).toContain('Static scan findings: 1 high, 1 low.');
    expect(tip.indexOf('[high]')).toBeLessThan(tip.indexOf('[low]'));
    expect(tip).toContain('scripts/setup.sh:2');
    expect(tip).toContain('not proof of bad intent');
  });

  it('a confirmação lista achados e a origem (URL ou pasta) e ignora itens só com baixa', () => {
    expect(
      riskConfirmation([{ kind: 'skill', name: 'ok', fonte: 'base', riscos: [] }], sources),
    ).toBeUndefined();
    expect(
      riskConfirmation(
        [{ kind: 'skill', name: 'ok', fonte: 'base', riscos: [risk({ severidade: 'baixa' })] }],
        sources,
      ),
    ).toBeUndefined();

    const one = riskConfirmation(
      [
        { kind: 'skill', name: 'instalador', fonte: 'base', riscos: [risk({})] },
        { kind: 'skill', name: 'limpa', fonte: 'base', riscos: [] },
      ],
      sources,
    );
    expect(one?.message).toBe('The static scan found risks in instalador. Install anyway?');
    expect(one?.detail).toContain('Skill instalador');
    expect(one?.detail).toContain('Source Base (https://example.com/recursos.git)');
    expect(one?.detail).toContain('Downloads and runs code in one step [high] scripts/setup.sh:2');
    expect(one?.detail).not.toContain('limpa');

    const two = riskConfirmation(
      [
        { kind: 'mcp', name: 'shell', fonte: 'local', riscos: [risk({ regra: 'mcp-shell' })] },
        {
          kind: 'agent',
          name: 'sorrateiro',
          fonte: 'sumiu',
          riscos: [risk({ severidade: 'media' })],
        },
      ],
      sources,
    );
    expect(two?.message).toContain('2 of the chosen items');
    expect(two?.detail).toContain('Source Local (/pastas/recursos)');
    expect(two?.detail).toContain('Source sumiu');
    expect(two?.detail).toContain('MCP server shell');
  });

  it('limita o tamanho do modal', () => {
    const many = Array.from({ length: 12 }, (_, index) => risk({ linha: index + 1 }));
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: 'skill' as const,
      name: `item-${index}`,
      fonte: 'base',
      riscos: many,
    }));
    const detail = riskConfirmation(items, sources)?.detail ?? '';
    expect(detail).toContain('item-7');
    expect(detail).not.toContain('item-8');
    expect(detail).toContain('and 2 more items with findings.');
    expect(detail).toContain('and 7 more.');
  });
});
