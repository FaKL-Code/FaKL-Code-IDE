import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readInstalledExtensions, type ExtensionId } from './extensions.js';
import {
  mergeKeybindings,
  mergeSettingsText,
  parseJsonc,
  stringifyJson,
  type Keybinding,
  type Settings,
} from './jsonc.js';
import type { EditorLocation } from './paths.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Editores encontrados nesta máquina, na ordem de preferência. */
export async function detectEditors(
  locations: readonly EditorLocation[],
): Promise<EditorLocation[]> {
  const found: EditorLocation[] = [];
  for (const location of locations) {
    if (
      (await exists(join(location.userDir, 'settings.json'))) ||
      (await exists(location.extensionsDir))
    ) {
      found.push(location);
    }
  }
  return found;
}

export interface ImportOptions {
  /** Troca valores que já existem na FaKL-Code pelos do editor de origem. */
  readonly overwrite: boolean;
}

export interface ImportResult {
  readonly settingsApplied: string[];
  readonly keybindingsAdded: number;
  readonly snippetsCopied: string[];
  /** Extensões instaladas no editor de origem; a instalação é feita pela IDE. */
  readonly extensions: ExtensionId[];
}

/**
 * Importa settings, atalhos e snippets de um editor para a pasta `User` da
 * FaKL-Code (RF-004). Nunca apaga nada no destino.
 */
export async function importFromEditor(
  source: EditorLocation,
  targetUserDir: string,
  options: ImportOptions,
): Promise<ImportResult> {
  await mkdir(targetUserDir, { recursive: true });

  let settingsApplied: string[] = [];
  const sourceSettings = await readText(join(source.userDir, 'settings.json'));
  if (sourceSettings !== undefined && sourceSettings.trim() !== '') {
    const targetPath = join(targetUserDir, 'settings.json');
    const targetText = (await readText(targetPath)) ?? '{}';
    const merged = mergeSettingsText(
      targetText,
      parseJsonc<Settings>(sourceSettings, 'settings.json'),
      {
        overwrite: options.overwrite,
      },
    );
    if (merged.applied.length > 0) {
      await writeFile(targetPath, merged.text);
    }
    settingsApplied = merged.applied;
  }

  let keybindingsAdded = 0;
  const sourceKeys = await readText(join(source.userDir, 'keybindings.json'));
  if (sourceKeys !== undefined && sourceKeys.trim() !== '') {
    const targetPath = join(targetUserDir, 'keybindings.json');
    const targetText = await readText(targetPath);
    const target = targetText?.trim()
      ? parseJsonc<Keybinding[]>(targetText, 'keybindings.json')
      : [];
    const { merged, added } = mergeKeybindings(
      target,
      parseJsonc<Keybinding[]>(sourceKeys, 'keybindings.json'),
    );
    if (added > 0) {
      await writeFile(targetPath, stringifyJson(merged));
    }
    keybindingsAdded = added;
  }

  const snippetsCopied: string[] = [];
  const sourceSnippets = join(source.userDir, 'snippets');
  if (await exists(sourceSnippets)) {
    const targetSnippets = join(targetUserDir, 'snippets');
    await mkdir(targetSnippets, { recursive: true });
    for (const name of await readdir(sourceSnippets)) {
      const target = join(targetSnippets, name);
      if (!options.overwrite && (await exists(target))) continue;
      await cp(join(sourceSnippets, name), target, { recursive: true });
      snippetsCopied.push(name);
    }
  }

  return {
    settingsApplied,
    keybindingsAdded,
    snippetsCopied: snippetsCopied.sort(),
    extensions: await readInstalledExtensions(source.extensionsDir),
  };
}
