/**
 * Biblioteca de servidores MCP da IDE (`~/.fakl/mcp.json`) e modelos das fontes.
 * O formato é o do `mcp.json` do VS Code (`servers` + `inputs`); `${input:id}`
 * vira um segredo `mcp.<id>`, guardado no cofre do sistema pela IDE.
 */

/** Segredo pedido na instalação (`inputs` do mcp.json). */
export interface McpInputSpec {
  readonly id: string;
  readonly description: string;
  readonly password?: boolean;
}

/** Metadados do bloco `fakl` de um modelo de servidor de uma fonte. */
export interface McpServerMeta {
  readonly descricao?: string;
  readonly categoria?: string;
  readonly oficial?: boolean;
  readonly relevancia?: 'alta' | 'média' | 'baixa';
  /** Como deixar o servidor só de leitura, ou o que ele pode alterar. */
  readonly somenteLeitura?: string;
  readonly fontes?: readonly string[];
  readonly licenca?: string;
  readonly versao?: string;
}

export interface McpServerEntry {
  readonly name: string;
  readonly type: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fakl?: McpServerMeta;
  /** Segredos (`${input:id}`) que o servidor usa. */
  readonly inputs: readonly McpInputSpec[];
}

export interface InstalledMcpServer extends McpServerEntry {
  /** Ids de segredo ainda não guardados; enquanto houver, o servidor não vai aos agentes. */
  readonly faltando: readonly string[];
}

export interface McpCatalogServer extends McpServerEntry {
  /** Id da fonte que oferece o modelo. */
  readonly fonte: string;
  readonly instalado: boolean;
}

/** `mcps.list`. */
export interface McpLibraryInfo {
  readonly servers: readonly InstalledMcpServer[];
  /** Arquivo da biblioteca (`~/.fakl/mcp.json`), editável à mão. */
  readonly arquivo: string;
}

/** `mcps.catalog`. */
export interface McpCatalog {
  readonly servers: readonly McpCatalogServer[];
}

const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isMcpInputId(value: string): boolean {
  return INPUT_ID.test(value);
}

/** Nome do segredo no cofre para um `${input:id}`. */
export function mcpSecretName(inputId: string): `mcp.${string}` {
  return `mcp.${inputId}`;
}
