import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { l10n } from '@fakl/i18n';

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };

export class JsoncError extends Error {
  constructor(file: string, errors: readonly ParseError[]) {
    const first = errors[0];
    const detail = first
      ? l10n.t('{0} at position {1}', printParseErrorCode(first.error), first.offset)
      : '';
    super(l10n.t('invalid JSON in {0}: {1}', file, detail));
    this.name = 'JsoncError';
  }
}

/**
 * Lê JSON com comentários e vírgulas finais, como os arquivos do VS Code. O
 * tipo de retorno é uma afirmação de quem chama; o conteúdo não é validado.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseJsonc<T>(text: string, file = l10n.t('file')): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as T;
  if (errors.length > 0) {
    throw new JsoncError(file, errors);
  }
  return value;
}

/**
 * Define ou remove (`value` undefined) chaves de primeiro nível preservando
 * comentários e formatação do texto original.
 */
export function setTopLevelKeys(text: string, values: Readonly<Record<string, unknown>>): string {
  let result = text.trim() === '' ? '{}' : text;
  for (const [key, value] of Object.entries(values)) {
    result = applyEdits(result, modify(result, [key], value, { formattingOptions: FORMAT }));
  }
  return result;
}

export type Settings = Record<string, unknown>;

/**
 * Mescla configurações de origem num settings.json existente, sem apagar o
 * que já existe. Chaves presentes nos dois lados só são trocadas com
 * `overwrite`. Devolve o novo texto e as chaves aplicadas.
 */
export function mergeSettingsText(
  targetText: string,
  source: Settings,
  options: { overwrite: boolean; skip?: ReadonlySet<string> },
): { text: string; applied: string[] } {
  const target = parseJsonc<Settings>(
    targetText.trim() === '' ? '{}' : targetText,
    'settings.json',
  );
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (options.skip?.has(key)) continue;
    if (key in target && !options.overwrite) continue;
    if (JSON.stringify(target[key]) === JSON.stringify(value)) continue;
    updates[key] = value;
  }
  return { text: setTopLevelKeys(targetText, updates), applied: Object.keys(updates) };
}

export interface Keybinding {
  readonly key: string;
  readonly command: string;
  readonly when?: string;
  readonly args?: unknown;
}

function keybindingId(binding: Keybinding): string {
  return JSON.stringify([binding.key, binding.command, binding.when ?? '', binding.args ?? null]);
}

/** Junta atalhos sem duplicar; os existentes vêm primeiro e mantêm a ordem. */
export function mergeKeybindings(
  target: readonly Keybinding[],
  source: readonly Keybinding[],
): { merged: Keybinding[]; added: number } {
  const seen = new Set(target.map(keybindingId));
  const merged = [...target];
  for (const binding of source) {
    const id = keybindingId(binding);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(binding);
  }
  return { merged, added: merged.length - target.length };
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 4)}\n`;
}
