import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResourceRisk } from '@fakl/protocol';

import { scanResource, type ResourceScanFile, type ResourceScanKind } from './resource-scan.js';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 6;
const CACHE_MAX = 500;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);

/**
 * Lê os arquivos de texto de uma pasta de skill (até o limite de quantidade e
 * tamanho; binários e pastas de dependências ficam de fora). Caminhos relativos,
 * com `/`, em ordem estável.
 */
export async function readScanFiles(dir: string): Promise<ResourceScanFile[]> {
  const files: ResourceScanFile[] = [];
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path, relative, depth + 1);
      } else if (entry.isFile()) {
        const size = (await stat(path).catch(() => undefined))?.size ?? Infinity;
        if (size > MAX_FILE_BYTES) continue;
        const buffer = await readFile(path).catch(() => undefined);
        // Arquivo com byte nulo é binário: não é texto que um agente leria.
        if (!buffer || buffer.includes(0)) continue;
        files.push({ caminho: relative, conteudo: buffer.toString('utf8') });
      }
    }
  };
  await walk(dir, '', 0);
  return files;
}

/** Hash do conteúdo que a varredura vê: o mesmo conteúdo dá o mesmo resultado. */
function hashOf(tipo: ResourceScanKind, files: readonly ResourceScanFile[]): string {
  const hash = createHash('sha256').update(tipo);
  for (const file of files)
    hash.update('\0').update(file.caminho).update('\0').update(file.conteudo);
  return hash.digest('hex');
}

/**
 * Varre e guarda o resultado por hash do conteúdo: listar o catálogo várias
 * vezes não repete a varredura de itens que não mudaram. Só em memória; nada
 * sai da máquina.
 */
export class ResourceRiskScanner {
  private readonly cache = new Map<string, readonly ResourceRisk[]>();

  scan(
    tipo: ResourceScanKind,
    nome: string,
    arquivos: readonly ResourceScanFile[],
  ): readonly ResourceRisk[] {
    const key = hashOf(tipo, arquivos);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const risks = scanResource({ tipo, nome, arquivos });
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, risks);
    return risks;
  }

  /** Agente (`.md`) ou skill (pasta). Erro de leitura não derruba a listagem: sem achados. */
  async scanEntry(
    tipo: 'agent' | 'skill',
    nome: string,
    entry: string,
  ): Promise<readonly ResourceRisk[]> {
    try {
      const files =
        tipo === 'agent'
          ? [{ caminho: `${nome}.md`, conteudo: await readFile(entry, 'utf8') }]
          : await readScanFiles(entry);
      return this.scan(tipo, nome, files);
    } catch {
      return [];
    }
  }

  /** Definição de um servidor MCP: o JSON do objeto dele, com recuo para ter linhas. */
  scanMcp(nome: string, raw: unknown): readonly ResourceRisk[] {
    return this.scan('mcp', nome, [
      { caminho: 'mcps.json', conteudo: JSON.stringify(raw, null, 2) },
    ]);
  }
}
