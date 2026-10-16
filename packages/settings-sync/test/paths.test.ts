import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appDataDir, editorLocations } from '../src/index.js';

describe('paths', () => {
  it('usa Application Support no macOS', () => {
    expect(appDataDir({ platform: 'darwin', home: '/Users/j' })).toBe(
      join('/Users/j', 'Library', 'Application Support'),
    );
  });

  it('usa APPDATA no Windows e cai para Roaming sem ela', () => {
    expect(appDataDir({ platform: 'win32', home: 'C:\\Users\\j', appData: 'D:\\Data' })).toBe(
      'D:\\Data',
    );
    expect(appDataDir({ platform: 'win32', home: '/h' })).toBe(join('/h', 'AppData', 'Roaming'));
  });

  it('usa XDG_CONFIG_HOME ou ~/.config no Linux', () => {
    expect(appDataDir({ platform: 'linux', home: '/h', xdgConfigHome: '/x' })).toBe('/x');
    expect(appDataDir({ platform: 'linux', home: '/h' })).toBe(join('/h', '.config'));
  });

  it('descreve VS Code, Insiders e VSCodium', () => {
    const locations = editorLocations({ platform: 'darwin', home: '/h' });
    expect(locations.map((l) => l.flavor)).toEqual(['vscode', 'vscode-insiders', 'vscodium']);
    const [code] = locations;
    expect(code?.userDir).toBe(join('/h', 'Library', 'Application Support', 'Code', 'User'));
    expect(code?.extensionsDir).toBe(join('/h', '.vscode', 'extensions'));
    expect(locations[2]?.extensionsDir).toBe(join('/h', '.vscode-oss', 'extensions'));
  });
});
