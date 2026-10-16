import { join } from 'node:path';

/** Editores de onde a configuração pode ser importada (RF-004). */
export type EditorFlavor = 'vscode' | 'vscode-insiders' | 'vscodium';

export interface EditorLocation {
  readonly flavor: EditorFlavor;
  readonly label: string;
  /** Pasta `User` com settings.json, keybindings.json e snippets/. */
  readonly userDir: string;
  /** Pasta onde o editor instala as extensões. */
  readonly extensionsDir: string;
}

export interface PlatformEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** %APPDATA% no Windows. */
  readonly appData?: string | undefined;
  /** $XDG_CONFIG_HOME no Linux. */
  readonly xdgConfigHome?: string | undefined;
}

const FLAVORS: readonly { flavor: EditorFlavor; label: string; appDir: string; dotDir: string }[] =
  [
    { flavor: 'vscode', label: 'VS Code', appDir: 'Code', dotDir: '.vscode' },
    {
      flavor: 'vscode-insiders',
      label: 'VS Code Insiders',
      appDir: 'Code - Insiders',
      dotDir: '.vscode-insiders',
    },
    { flavor: 'vscodium', label: 'VSCodium', appDir: 'VSCodium', dotDir: '.vscode-oss' },
  ];

/** Pasta de dados de aplicativos do sistema, onde ficam as pastas `User`. */
export function appDataDir(env: PlatformEnv): string {
  switch (env.platform) {
    case 'darwin':
      return join(env.home, 'Library', 'Application Support');
    case 'win32':
      return env.appData ?? join(env.home, 'AppData', 'Roaming');
    default:
      return env.xdgConfigHome ?? join(env.home, '.config');
  }
}

/** Onde cada editor suportado guarda configuração e extensões neste sistema. */
export function editorLocations(env: PlatformEnv): EditorLocation[] {
  const base = appDataDir(env);
  return FLAVORS.map(({ flavor, label, appDir, dotDir }) => ({
    flavor,
    label,
    userDir: join(base, appDir, 'User'),
    extensionsDir: join(env.home, dotDir, 'extensions'),
  }));
}

export function currentPlatformEnv(): PlatformEnv {
  return {
    platform: process.platform,
    home: process.env.HOME ?? process.env.USERPROFILE ?? '',
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  };
}
