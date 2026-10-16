import { describe, expect, it } from 'vitest';

import { ALL_CORE_METHODS, CoreMethods, isCoreMethod, splitMethod } from '../src/index.js';

describe('methods', () => {
  it('lista todos os métodos do SDD sem duplicatas', () => {
    const expected = Object.values(CoreMethods).reduce((sum, actions) => sum + actions.length, 0);
    expect(ALL_CORE_METHODS).toHaveLength(expected);
    expect(new Set(ALL_CORE_METHODS).size).toBe(ALL_CORE_METHODS.length);
  });

  it('reconhece métodos conhecidos e recusa os demais', () => {
    expect(isCoreMethod('runs.start')).toBe(true);
    expect(isCoreMethod('agents.terminal.attach')).toBe(true);
    expect(isCoreMethod('runs.explode')).toBe(false);
    expect(isCoreMethod('runs')).toBe(false);
  });

  it('separa domínio e ação no primeiro ponto', () => {
    expect(splitMethod('agents.terminal.attach')).toEqual({
      domain: 'agents',
      action: 'terminal.attach',
    });
    expect(splitMethod('costs.limits.set')).toEqual({ domain: 'costs', action: 'limits.set' });
  });
});
