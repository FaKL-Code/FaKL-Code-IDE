import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * O que não vai para o git do vault (SDD 10.2). É estado do editor que muda a
 * cada abertura do Obsidian e varia por máquina, então só gera conflito.
 * Seguem versionados `.obsidian/app.json`, `appearance.json`,
 * `core-plugins.json`, `community-plugins.json`, `hotkeys.json` e a pasta
 * `plugins/`: são as preferências que o usuário quer iguais nas duas máquinas.
 */
export const VAULT_IGNORED = ['.obsidian/workspace*.json', '.obsidian/cache', '.trash/'] as const;

/** Comentário que marca o bloco; com ele presente, a IDE não mexe mais no arquivo. */
export const VAULT_IGNORE_MARKER =
  '# FaKL-Code: estado do Obsidian que varia por máquina e não deve ser sincronizado';

const norm = (line: string): string => line.trim().replace(/^\//, '').replace(/\/$/, '');

/**
 * Garante o `.gitignore` do vault sem sobrescrever o do usuário: só acrescenta,
 * em um bloco comentado, as linhas que faltam. Respeita quem já ignorou, quem
 * negou a linha com `!` e quem apagou o bloco depois (o comentário fica).
 * Devolve se o arquivo mudou.
 */
export async function ensureVaultGitignore(root: string): Promise<boolean> {
  const file = join(root, '.gitignore');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.includes(VAULT_IGNORE_MARKER)) return false;
  const lines = new Set(current.split(/\r?\n/).map(norm));
  const missing = VAULT_IGNORED.filter(
    (pattern) => !lines.has(norm(pattern)) && !lines.has(`!${norm(pattern)}`),
  );
  if (missing.length === 0) return false;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lead = current === '' || current.endsWith('\n') ? '' : eol;
  const gap = current === '' ? '' : eol;
  await writeFile(
    file,
    `${current}${lead}${gap}${[VAULT_IGNORE_MARKER, ...missing].join(eol)}${eol}`,
  );
  return true;
}

/** O arquivo é estado do editor que a IDE ignora? Só esses saem do índice, nunca o que o usuário ignorou. */
export function isEditorState(path: string): boolean {
  return /^\.obsidian\/workspace[^/]*\.json$|^\.obsidian\/cache(\/|$)|^\.trash\//.test(path);
}
