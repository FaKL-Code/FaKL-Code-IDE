import { describe, expect, it } from 'vitest';

import { pendingOfficialExtensions } from '../src/official-extensions-model.js';

describe('pendingOfficialExtensions', () => {
  it('acha as extensões oficiais instaladas', () => {
    expect(
      pendingOfficialExtensions(['vscode.git', 'openai.chatgpt', 'anthropic.claude-code'], []),
    ).toEqual([
      { id: 'openai.chatgpt', name: 'Codex' },
      { id: 'anthropic.claude-code', name: 'Claude Code' },
    ]);
  });

  it('ignora a caixa do id e as que já ganharam o aviso', () => {
    expect(pendingOfficialExtensions(['OpenAI.ChatGPT'], [])).toHaveLength(1);
    expect(pendingOfficialExtensions(['openai.chatgpt'], ['OPENAI.chatgpt'])).toEqual([]);
    expect(
      pendingOfficialExtensions(['openai.chatgpt', 'anthropic.claude-code'], ['openai.chatgpt']),
    ).toEqual([{ id: 'anthropic.claude-code', name: 'Claude Code' }]);
  });

  it('não avisa de quem não instalou nada', () => {
    expect(pendingOfficialExtensions(['vscode.git'], [])).toEqual([]);
  });
});
