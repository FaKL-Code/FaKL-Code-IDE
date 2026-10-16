import type { AgentOptionInfo } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  findNewSession,
  logoKey,
  optionKind,
  optionValueLabel,
  pendingOptionChanges,
  rememberOptions,
  sortOptions,
  withChoices,
} from '../src/webview/chat-model.js';

const model: AgentOptionInfo = {
  id: 'model',
  nome: 'Modelo',
  categoria: 'model',
  atual: 'a',
  valores: [
    { id: 'a', nome: 'Alpha' },
    { id: 'b', nome: 'Beta' },
  ],
};
const effort: AgentOptionInfo = {
  id: 'effort',
  nome: 'Esforço',
  categoria: 'thought_level',
  atual: 'low',
  valores: [
    { id: 'low', nome: 'Baixo' },
    { id: 'high', nome: 'Alto' },
  ],
};
const fast: AgentOptionInfo = { id: 'fast_mode', nome: 'Fast', atual: false };

describe('logoKey', () => {
  it('escolhe a marca pelo provedor do perfil: produto no agente, empresa no provedor', () => {
    expect(logoKey('anthropic', true)).toBe('claude');
    expect(logoKey('openai', true)).toBe('openai');
    expect(logoKey('google', true)).toBe('gemini');
    expect(logoKey('ollama', true)).toBe('ollama');
    expect(logoKey('lmstudio')).toBe('lmstudio');
    expect(logoKey('anthropic')).toBe('anthropic');
    expect(logoKey('google')).toBe('google');
  });

  it('não inventa marca para provedor desconhecido nem lê o id do perfil', () => {
    expect(logoKey('outro', true)).toBeUndefined();
    // Um agente ACP chamado "claude-qualquer" de outro provedor não ganha a marca do Claude.
    expect(logoKey('opencode', true)).toBeUndefined();
    expect(logoKey(undefined)).toBeUndefined();
  });
});

describe('opções do agente', () => {
  it('classifica por categoria, id e nome', () => {
    expect(optionKind(model)).toBe('model');
    expect(optionKind(effort)).toBe('effort');
    expect(optionKind(fast)).toBe('fast');
    expect(optionKind({ id: 'mode', nome: 'Modo', categoria: 'mode' })).toBe('mode');
    expect(optionKind({ id: 'x', nome: 'Outra' })).toBe('other');
  });

  it('ordena modelo, raciocínio, fast, modo e o resto', () => {
    const other: AgentOptionInfo = { id: 'x', nome: 'Outra', atual: true };
    const mode: AgentOptionInfo = { id: 'mode', nome: 'Modo', categoria: 'mode', atual: 'a' };
    expect(sortOptions([other, mode, fast, effort, model]).map((o) => o.id)).toEqual([
      'model',
      'effort',
      'fast_mode',
      'mode',
      'x',
    ]);
  });

  it('mostra o nome do valor atual', () => {
    expect(optionValueLabel(model)).toBe('Alpha');
    expect(optionValueLabel(fast)).toBe('Fast');
    expect(optionValueLabel({ ...model, atual: 'zzz' })).toBe('Modelo');
  });

  it('lembra as opções por perfil e ignora sessões sem opções', () => {
    const known = rememberOptions({ old: [fast] }, [
      { profileId: 'claude', opcoes: [model] },
      { profileId: 'codex', opcoes: [] },
    ]);
    expect(known).toEqual({ old: [fast], claude: [model] });
  });

  it('aplica as escolhas só quando válidas', () => {
    const shown = withChoices([model, effort, fast], {
      model: 'b',
      effort: 'nope',
      fast_mode: true,
    });
    expect(shown.map((o) => o.atual)).toEqual(['b', 'low', true]);
  });

  it('lista só o que difere do estado do agente', () => {
    expect(
      pendingOptionChanges([model, effort, fast], { model: 'b', effort: 'low', fast_mode: true }),
    ).toEqual([
      { id: 'model', value: 'b' },
      { id: 'fast_mode', value: true },
    ]);
    expect(pendingOptionChanges([model], { model: 'inexistente' })).toEqual([]);
  });

  it('acha a conversa nova do perfil', () => {
    const list = [
      { sessionId: '1', profileId: 'claude' },
      { sessionId: '2', profileId: 'codex' },
      { sessionId: '3', profileId: 'claude' },
    ];
    expect(findNewSession(new Set(['1']), list, 'claude')?.sessionId).toBe('3');
    expect(findNewSession(new Set(['1', '3']), list, 'claude')).toBeUndefined();
  });
});
