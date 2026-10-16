import { describe, expect, it } from 'vitest';

import {
  JsoncError,
  mergeKeybindings,
  mergeSettingsText,
  parseJsonc,
  setTopLevelKeys,
} from '../src/index.js';

describe('jsonc', () => {
  it('lê comentários e vírgulas finais', () => {
    expect(parseJsonc('{ // tema\n "a": 1, }')).toEqual({ a: 1 });
  });

  it('acusa JSON quebrado com o nome do arquivo', () => {
    expect(() => parseJsonc('{ "a": ', 'settings.json')).toThrow(JsoncError);
    expect(() => parseJsonc('{ "a": ', 'settings.json')).toThrow(/settings\.json/);
  });

  it('altera chaves preservando comentários', () => {
    const text = '{\n    // fonte\n    "editor.fontSize": 14\n}';
    const result = setTopLevelKeys(text, { 'editor.fontSize': 16, 'files.eol': '\n' });
    expect(result).toContain('// fonte');
    expect(parseJsonc(result)).toEqual({ 'editor.fontSize': 16, 'files.eol': '\n' });
    expect(parseJsonc(setTopLevelKeys(result, { 'files.eol': undefined }))).toEqual({
      'editor.fontSize': 16,
    });
    expect(parseJsonc(setTopLevelKeys('', { a: 1 }))).toEqual({ a: 1 });
  });

  it('mescla settings sem sobrescrever, a não ser que pedido', () => {
    const target = '{ "a": 1, "b": 2 }';
    const source = { a: 9, b: 2, c: 3, d: 4 };
    const keep = mergeSettingsText(target, source, { overwrite: false, skip: new Set(['d']) });
    expect(keep.applied).toEqual(['c']);
    expect(parseJsonc(keep.text)).toEqual({ a: 1, b: 2, c: 3 });

    const replace = mergeSettingsText(target, source, { overwrite: true });
    expect(replace.applied).toEqual(['a', 'c', 'd']);
    expect(parseJsonc(replace.text)).toEqual({ a: 9, b: 2, c: 3, d: 4 });
  });

  it('junta atalhos sem duplicar', () => {
    const a = { key: 'ctrl+a', command: 'x' };
    const b = { key: 'ctrl+b', command: 'y', when: 'editorFocus' };
    const bOther = { key: 'ctrl+b', command: 'y', when: 'terminalFocus' };
    const { merged, added } = mergeKeybindings([a, b], [b, bOther, a]);
    expect(added).toBe(1);
    expect(merged).toEqual([a, b, bOther]);
  });
});
