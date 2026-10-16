/**
 * Variáveis do ambiente do usuário que chegam aos agentes (SDD 8.4). Tudo o
 * que não está aqui fica de fora, para nenhum segredo do shell vazar para um
 * agente. Credenciais entram pelo cofre, nunca pelo ambiente herdado: uma
 * chave de API (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) só chega ao
 * agente do provedor dela, vinda do cofre da IDE (ADR 0035).
 */
const ALLOWED = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  // Rede: proxy e certificados corporativos
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

const PREFIXES = ['LC_', 'XDG_'];

const allowed = new Set(ALLOWED);

function isAllowed(name: string): boolean {
  // No Windows os nomes não diferenciam maiúsculas ("Path", "PATH").
  const upper = name.toUpperCase();
  return allowed.has(upper) || PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Filtra o ambiente herdado e soma as variáveis extras da sessão. */
export function agentEnv(
  inherited: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowed(name)) env[name] = value;
  }
  return { ...env, ...extra };
}
