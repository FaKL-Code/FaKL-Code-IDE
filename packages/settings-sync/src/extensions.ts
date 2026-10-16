import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseJsonc } from './jsonc.js';

/** Id `publisher.nome` em minúsculas, como o VS Code compara extensões. */
export type ExtensionId = string;

interface ExtensionsManifestEntry {
  identifier?: { id?: string };
}

const VERSIONED_DIR = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)-\d+\.\d+\.\d+/i;

export function normalizeExtensionId(id: string): ExtensionId {
  return id.trim().toLowerCase();
}

/**
 * Lista as extensões instaladas numa pasta de extensões. Usa o
 * `extensions.json` mantido pelo VS Code e, se ele não existir, os nomes das
 * pastas (`publisher.nome-1.2.3`).
 */
export async function readInstalledExtensions(extensionsDir: string): Promise<ExtensionId[]> {
  const ids = new Set<ExtensionId>();
  try {
    const text = await readFile(join(extensionsDir, 'extensions.json'), 'utf8');
    const entries = parseJsonc<ExtensionsManifestEntry[]>(text, 'extensions.json');
    for (const entry of entries) {
      if (entry.identifier?.id) ids.add(normalizeExtensionId(entry.identifier.id));
    }
  } catch {
    let names: string[];
    try {
      names = await readdir(extensionsDir);
    } catch {
      return [];
    }
    for (const name of names) {
      const match = VERSIONED_DIR.exec(name);
      if (match?.[1]) ids.add(normalizeExtensionId(match[1]));
    }
  }
  return [...ids].sort();
}

/** O que falta instalar aqui para ficar igual à lista desejada. */
export function missingExtensions(
  installed: readonly ExtensionId[],
  wanted: readonly ExtensionId[],
): ExtensionId[] {
  const have = new Set(installed.map(normalizeExtensionId));
  return [...new Set(wanted.map(normalizeExtensionId))].filter((id) => !have.has(id)).sort();
}
