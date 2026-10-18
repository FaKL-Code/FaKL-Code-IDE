/** Tipo de recurso de IA da biblioteca do usuário (`~/.fakl/resources`). */
export type ResourceKind = 'agent' | 'skill';

export const RESOURCE_KINDS: readonly ResourceKind[] = ['agent', 'skill'];

export function isResourceKind(value: unknown): value is ResourceKind {
  return value === 'agent' || value === 'skill';
}

/** Nível de custo declarado no bloco `fakl` do frontmatter. */
export type ResourceLevel = 'leve' | 'padrao' | 'pesado';

/** Gravidade de um achado da varredura estática (ADR 0042). */
export type ResourceRiskSeverity = 'alta' | 'media' | 'baixa';

/**
 * Achado da varredura estática de um agente, skill ou servidor MCP. É heurística:
 * um achado não prova má-fé, e a falta de achados não prova segurança.
 */
export interface ResourceRisk {
  /** Id estável da regra (`prompt-injection`, `baixa-e-executa`, `mcp-shell`...). */
  readonly regra: string;
  readonly severidade: ResourceRiskSeverity;
  /** Arquivo do item onde foi achado (`SKILL.md`, `scripts/x.sh`; `mcps.json` para MCP). */
  readonly arquivo: string;
  /** Linha (a partir de 1); para MCP, linha do JSON da definição do servidor. */
  readonly linha: number;
  /** Trecho curto da linha, com invisíveis trocados por `_`. */
  readonly trecho: string;
}

/** Um agente ou skill, da biblioteca instalada ou de uma fonte de recursos. */
export interface ResourceInfo {
  readonly kind: ResourceKind;
  /** Slug: nome do arquivo do agente ou da pasta da skill. */
  readonly name: string;
  readonly description: string;
  readonly nivel?: ResourceLevel;
  /** Perfil sugerido, como `claude-haiku`, `claude-sonnet`, `claude-opus` ou `codex`. */
  readonly perfil?: string;
  readonly modelo?: string;
  readonly alternativa?: string;
  readonly fontes?: readonly string[];
  readonly licenca?: string;
  /**
   * `false` (`fakl.padrao: false`): item opcional da fonte. Os demais aparecem
   * como recomendados na instalação; nenhum é instalado sem o usuário escolher.
   */
  readonly padrao?: boolean;
  /** `fonte` quando veio de uma fonte de recursos; `usuario` quando foi criado na biblioteca. */
  readonly origem: 'fonte' | 'usuario';
  /** Id da fonte de onde o item veio ou foi instalado, quando se sabe. */
  readonly fonte?: string;
  /** Arquivo `.md` do agente ou `SKILL.md` da skill. */
  readonly path: string;
  /** Achados da varredura; só vêm no catálogo e no resultado de `resources.install`. */
  readonly riscos?: readonly ResourceRisk[];
}

/** `resources.list`: o que está instalado. */
export interface ResourceLibrary {
  readonly agents: readonly ResourceInfo[];
  readonly skills: readonly ResourceInfo[];
  /** Pasta da biblioteca (`~/.fakl/resources`). */
  readonly dir: string;
}

export interface CatalogResourceInfo extends ResourceInfo {
  /** Id da fonte que oferece o item. */
  readonly fonte: string;
  /** Já está na biblioteca do usuário. */
  readonly instalado: boolean;
  /** Achados da varredura estática do item na fonte (vazio: nada achado, sem garantia). */
  readonly riscos: readonly ResourceRisk[];
}

/** `resources.catalog`: agentes e skills de todas as fontes cadastradas. */
export interface ResourceCatalog {
  readonly agents: readonly CatalogResourceInfo[];
  readonly skills: readonly CatalogResourceInfo[];
}

/** `resources.get`. */
export interface ResourceContent {
  readonly info: ResourceInfo;
  readonly content: string;
  /** `false` quando veio de uma fonte sem estar instalado. */
  readonly instalado?: boolean;
}

/** Servidor MCP resumido para o maestro: o que faz e se os subagentes já o recebem. */
export interface McpResourceSummary {
  readonly name: string;
  readonly description: string;
  readonly categoria?: string;
  /** Segredos que faltam; enquanto houver, o servidor não vai aos agentes. */
  readonly faltando?: readonly string[];
}

/** Um resultado de `resources.find` (ferramenta find_resources do maestro). */
export interface ResourceHit {
  readonly kind: ResourceKind | 'mcp';
  readonly name: string;
  readonly description: string;
  readonly nivel?: ResourceLevel;
  readonly perfil?: string;
  readonly categoria?: string;
  /** Instalado na IDE; agentes e skills das fontes servem mesmo sem instalar. */
  readonly instalado: boolean;
  /** Servidor MCP instalado mas sem algum segredo, fora das sessões. */
  readonly faltando?: readonly string[];
  readonly score: number;
}

/**
 * Fonte de recursos: um repositório git (clonado em `~/.fakl/sources/<id>`)
 * ou uma pasta local, com `agents/`, `skills/` e `mcps.json`, todos opcionais.
 */
export type ResourceSourceKind = 'git' | 'pasta';

/** Uma fonte cadastrada (`sources.list`). */
export interface ResourceSource {
  readonly id: string;
  readonly nome: string;
  readonly tipo: ResourceSourceKind;
  /** Repositório git: URL de clone. */
  readonly url?: string;
  /** Repositório git: branch acompanhado; sem ele, o padrão do remoto. */
  readonly branch?: string;
  /** Pasta lida: a pasta local ou o clone do repositório. */
  readonly caminho: string;
  /** Última atualização bem-sucedida (ISO 8601). */
  readonly atualizadaEm?: string;
  /** Commit atual do clone. */
  readonly commit?: string;
  /** Por que a fonte não pôde ser lida ou atualizada. */
  readonly erro?: string;
  readonly agents: number;
  readonly skills: number;
  readonly mcps: number;
}

/** `sources.add`: `url` (git) ou `caminho` (pasta). */
export interface AddResourceSourceParams {
  readonly url?: string;
  readonly branch?: string;
  readonly caminho?: string;
  readonly nome?: string;
}
