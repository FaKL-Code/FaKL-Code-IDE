/**
 * O que a IDE consulta na rede por conta própria (ADR 0045). Funções puras,
 * sem VS Code: o host lê as configurações ({@link NetworkSettings}) e daqui sai
 * se uma consulta automática pode ir. Uma consulta pedida por comando
 * (`manual`) sempre pode: o interruptor só cobre o que a FaKL faz sozinha.
 */

/** Configuração `fakl.rede.consultasAutomaticas`, sem o prefixo `fakl.`. */
export const AUTOMATIC_QUERIES_SETTING = 'rede.consultasAutomaticas';

/** Onde a lista completa do que a IDE consulta está descrita. */
export const PRIVACY_GUIDE =
  'https://github.com/FaKL-Code/FaKL-Code-IDE/blob/main/docs/privacidade.md';

export interface NetworkSettings {
  /** `fakl.rede.consultasAutomaticas`: o interruptor único. */
  readonly automatic: boolean;
  /** `fakl.providers.checkUpdates`: consulta ao npm ao listar provedores. */
  readonly adapterCheck: boolean;
  /** `fakl.update.notify`: aviso de versão nova (macOS). */
  readonly updateNotify: boolean;
  /** `update.mode` do VS Code; `none` desliga o atualizador do editor. */
  readonly updateMode?: string;
}

/** Pode consultar o npm pela versão mais nova dos adaptadores e CLIs? */
export function mayQueryAdapterVersions(settings: NetworkSettings, manual = false): boolean {
  return manual || (settings.automatic && settings.adapterCheck);
}

/** Pode procurar o aviso de versão nova da IDE (macOS)? */
export function mayCheckUpdateNotice(settings: NetworkSettings, manual = false): boolean {
  return manual || (settings.automatic && settings.updateNotify && settings.updateMode !== 'none');
}
