import { l10n } from '@fakl/i18n';
import type { LimitAction, LimitName, LimitRule, RunLimits } from '@fakl/protocol';

export const LIMIT_NAMES: readonly LimitName[] = ['rodadas', 'tempoMin', 'tokens', 'custoUsd'];
const ACTIONS: readonly LimitAction[] = ['perguntar', 'rascunho', 'escalar', 'descartar'];

/** Limites padrão quando ninguém define: evitam uma execução sem fim. */
export const DEFAULT_LIMITS: RunLimits = {
  rodadas: { valor: 5, acao: 'perguntar' },
  tempoMin: { valor: 120, acao: 'perguntar' },
  profundidadeMaxima: 2,
  orcamentoExtra: 1.5,
};

/** O mais específico vence, chave por chave: tarefa, playbook, global, padrão (RF-206). */
export function effectiveLimits(...layers: readonly (RunLimits | undefined)[]): RunLimits {
  const result: Record<string, unknown> = {};
  for (const layer of [...layers, DEFAULT_LIMITS]) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && result[key] === undefined) result[key] = value;
    }
  }
  return result;
}

/** Multiplica os valores dos limites (aumentar limite, escalar com orçamento extra). */
export function scaleLimits(limits: RunLimits, factor: number, only?: LimitName): RunLimits {
  const result: Record<string, unknown> = { ...limits };
  for (const name of LIMIT_NAMES) {
    const rule = limits[name];
    if (!rule || (only && only !== name)) continue;
    const valor = name === 'rodadas' ? Math.ceil(rule.valor * factor) : rule.valor * factor;
    result[name] = { ...rule, valor: Math.max(valor, rule.valor + (name === 'rodadas' ? 1 : 0)) };
  }
  return result;
}

export interface Consumption {
  readonly rodadas: number;
  readonly tempoMin: number;
  readonly tokens: number;
  readonly custoUsd: number;
}

/** Primeiro limite atingido, se algum. */
export function exceeded(
  limits: RunLimits,
  used: Consumption,
): { limite: LimitName; valor: number; atual: number; acao: LimitAction } | undefined {
  for (const name of LIMIT_NAMES) {
    const rule = limits[name];
    if (rule && used[name] >= rule.valor) {
      return { limite: name, valor: rule.valor, atual: used[name], acao: rule.acao ?? 'perguntar' };
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida limites vindos de YAML ou da API; lança com a mensagem para o usuário. */
export function parseLimits(raw: unknown, where: string): RunLimits | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) throw new Error(l10n.t('{0}: limites must be an object', where));
  const result: Record<string, unknown> = {};
  for (const name of LIMIT_NAMES) {
    const rule = raw[name];
    if (rule === undefined || rule === null) continue;
    const parsed: LimitRule | undefined =
      typeof rule === 'number'
        ? { valor: rule }
        : isObject(rule) && typeof rule.valor === 'number'
          ? {
              valor: rule.valor,
              ...(rule.acao !== undefined ? { acao: rule.acao as LimitAction } : {}),
            }
          : undefined;
    if (!parsed || !(parsed.valor > 0)) {
      throw new Error(l10n.t('{0}: {1} must have a value greater than zero', where, name));
    }
    if (parsed.acao !== undefined && !ACTIONS.includes(parsed.acao)) {
      throw new Error(l10n.t('{0}: {1}.acao must be {2}', where, name, ACTIONS.join(', ')));
    }
    result[name] = parsed;
  }
  for (const key of ['orcamentoExtra', 'profundidadeMaxima'] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || value < (key === 'profundidadeMaxima' ? 0 : 1)) {
      throw new Error(l10n.t('{0}: {1} is invalid', where, key));
    }
    result[key] = value;
  }
  if (raw.perfilEscalada !== undefined) {
    if (typeof raw.perfilEscalada !== 'string') {
      throw new Error(l10n.t('{0}: perfilEscalada must be a profile id', where));
    }
    result.perfilEscalada = raw.perfilEscalada;
  }
  return result;
}
