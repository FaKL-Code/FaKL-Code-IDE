import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectEditors, editorLocations, importFromEditor, parseJsonc } from '../src/index.js';
import { put, read, tempDir } from './helpers.js';

describe('importer', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => dir.cleanup());

  function locations() {
    return editorLocations({
      platform: 'linux',
      home: dir.path,
      xdgConfigHome: join(dir.path, 'cfg'),
    });
  }

  it('detecta só os editores instalados', async () => {
    const [code, , codium] = locations();
    if (!code || !codium) throw new Error('locais esperados');
    await put(join(code.userDir, 'settings.json'), '{}');
    await put(join(codium.extensionsDir, 'extensions.json'), '[]');
    expect((await detectEditors(locations())).map((l) => l.flavor)).toEqual(['vscode', 'vscodium']);
  });

  it('importa settings, atalhos, snippets e lista extensões sem apagar o destino', async () => {
    const [code] = locations();
    if (!code) throw new Error('local esperado');
    const target = join(dir.path, 'fakl', 'User');

    await put(
      join(code.userDir, 'settings.json'),
      '{ // meu tema\n "workbench.colorTheme": "Dracula", "a": 2 }',
    );
    await put(join(code.userDir, 'keybindings.json'), '[{ "key": "ctrl+k", "command": "x" }]');
    await put(join(code.userDir, 'snippets', 'ts.json'), '{"log": {}}');
    await put(join(code.extensionsDir, 'extensions.json'), '[{"identifier":{"id":"golang.go"}}]');

    await put(join(target, 'settings.json'), '{ "a": 1 }');
    await put(join(target, 'snippets', 'ts.json'), 'meu');

    const result = await importFromEditor(code, target, { overwrite: false });

    expect(result).toEqual({
      settingsApplied: ['workbench.colorTheme'],
      keybindingsAdded: 1,
      snippetsCopied: [],
      extensions: ['golang.go'],
    });
    expect(parseJsonc(await read(join(target, 'settings.json')))).toEqual({
      a: 1,
      'workbench.colorTheme': 'Dracula',
    });
    expect(parseJsonc(await read(join(target, 'keybindings.json')))).toEqual([
      { key: 'ctrl+k', command: 'x' },
    ]);
    expect(await read(join(target, 'snippets', 'ts.json'))).toBe('meu');

    const again = await importFromEditor(code, target, { overwrite: true });
    expect(again.settingsApplied).toEqual(['a']);
    expect(again.keybindingsAdded).toBe(0);
    expect(again.snippetsCopied).toEqual(['ts.json']);
  });

  it('funciona com o editor de origem sem nenhum arquivo', async () => {
    const [, insiders] = locations();
    if (!insiders) throw new Error('local esperado');
    const result = await importFromEditor(insiders, join(dir.path, 'alvo'), { overwrite: false });
    expect(result).toEqual({
      settingsApplied: [],
      keybindingsAdded: 0,
      snippetsCopied: [],
      extensions: [],
    });
  });
});
