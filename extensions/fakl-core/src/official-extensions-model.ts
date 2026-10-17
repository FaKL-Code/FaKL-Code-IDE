/**
 * As extensões oficiais do Codex e do Claude Code têm as próprias conversas: não
 * expõem API para outra extensão enviar um prompt nem para conectar-se à sessão
 * delas. Só os agentes que a IDE sobe (por ACP) aparecem na Mesa, no café e no
 * Maestro; quem instala a extensão achando o contrário ganha um aviso.
 */
export interface OfficialExtension {
  readonly id: string;
  readonly name: string;
}

export const OFFICIAL_EXTENSIONS: readonly OfficialExtension[] = [
  { id: 'openai.chatgpt', name: 'Codex' },
  { id: 'anthropic.claude-code', name: 'Claude Code' },
];

/**
 * As extensões instaladas que ainda não ganharam o aviso. O Open VSX e o VS Code
 * escrevem o id em caixas diferentes, então a comparação ignora a caixa.
 */
export function pendingOfficialExtensions(
  installedIds: readonly string[],
  alreadyShown: readonly string[],
): OfficialExtension[] {
  const installed = new Set(installedIds.map((id) => id.toLowerCase()));
  const shown = new Set(alreadyShown.map((id) => id.toLowerCase()));
  return OFFICIAL_EXTENSIONS.filter(
    (extension) => installed.has(extension.id) && !shown.has(extension.id),
  );
}
