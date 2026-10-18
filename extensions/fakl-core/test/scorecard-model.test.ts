import { useLocale } from '@fakl/i18n';
import type { ScorecardEntry } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  entryDescription,
  entryTooltipLines,
  formatDuration,
  hasEnoughData,
  periodLabel,
} from '../src/scorecard-model.js';

const entry = (extra: Partial<ScorecardEntry> = {}): ScorecardEntry => ({
  perfilId: 'claude',
  nome: 'Claude',
  sessoes: 9,
  tarefas: 8,
  tarefasConcluidas: 6,
  tarefasFalhas: 1,
  tarefasCanceladas: 1,
  duracaoMediaMs: 750_000,
  duracaoMedianaMs: 45_000,
  tokensEntrada: 1000,
  tokensSaida: 200,
  custoUsd: 4.5,
  custoMedioTarefaUsd: 0.56,
  arquivosAceitos: 9,
  arquivosRejeitados: 3,
  taxaAprovacao: 0.75,
  limites: 2,
  ...extra,
});

afterEach(() => {
  useLocale('en');
});

describe('placar na árvore', () => {
  it('formata a duração de forma curta', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(750_000)).toBe('12m30s');
    expect(formatDuration(3_900_000)).toBe('1h05m');
  });

  it('mostra aprovação, duração e custo médios com amostra suficiente', () => {
    expect(hasEnoughData(entry(), 5)).toBe(true);
    expect(entryDescription(entry(), 5)).toBe('8 task(s) · 75% approved · 12m30s · $0.56');
  });

  it('avisa "poucos dados" em vez de números de uma amostra pequena', () => {
    const few = entry({ tarefas: 4 });
    expect(hasEnoughData(few, 5)).toBe(false);
    expect(entryDescription(few, 5)).toBe('4 task(s) · little data');
    expect(entryTooltipLines(few, 5).join('\n')).toContain('Fewer than 5 tasks');
  });

  it('omite o que não foi medido', () => {
    const bare: ScorecardEntry = {
      perfilId: 'claude',
      nome: 'Claude',
      sessoes: 9,
      tarefas: 8,
      tarefasConcluidas: 8,
      tarefasFalhas: 0,
      tarefasCanceladas: 0,
      tokensEntrada: 0,
      tokensSaida: 0,
      custoUsd: 0,
      arquivosAceitos: 0,
      arquivosRejeitados: 0,
      limites: 0,
    };
    expect(entryDescription(bare, 5)).toBe('8 task(s)');
  });

  it('detalha no tooltip, marca o perfil removido e lembra que são sinais indiretos', () => {
    const lines = entryTooltipLines(entry({ removido: true }), 5);
    expect(lines[0]).toBe('**Claude** (profile removed)');
    expect(lines).toContain('Tasks: 6 done, 1 failed, 1 canceled');
    expect(lines).toContain('Average time: 12m30s · median: 45s');
    expect(lines).toContain('Diff files: 9 accepted, 3 rejected · approval 75%');
    expect(lines).toContain('Usage limits hit: 2');
    expect(lines.at(-1)).toBe(
      'These are indirect signals; they do not measure the quality of the code.',
    );
  });

  it('fala português', () => {
    useLocale('pt-BR');
    expect(periodLabel('7d')).toBe('Últimos 7 dias');
    expect(periodLabel('total')).toBe('Todo o histórico registrado');
    expect(entryDescription(entry({ tarefas: 2 }), 5)).toBe('2 tarefa(s) · poucos dados');
    expect(entryDescription(entry(), 5)).toBe('8 tarefa(s) · 75% aprovado · 12m30s · US$ 0.56');
    expect(entryTooltipLines(entry(), 5).at(-1)).toBe(
      'São sinais indiretos; não medem a qualidade do código.',
    );
  });
});
