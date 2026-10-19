/** Tipos das integrações (SDD 11): SSH, Hostinger e Lovable. */

export type SshPolicyName = 'livre' | 'confirmar' | 'leitura' | 'bloqueado';

export type SshHostOrigin = 'config' | 'manual' | 'hostinger';

/** Host do gerenciador de SSH (`ssh.hosts.list`). */
export interface SshHostInfo {
  /** Nome do host; para hosts do ~/.ssh/config, o alias de lá. */
  readonly alias: string;
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly origem: SshHostOrigin;
  readonly grupos: readonly string[];
  readonly tags: readonly string[];
  readonly politica: SshPolicyName;
  /** VPS da Hostinger de onde o host veio. */
  readonly hostingerId?: number;
}

/** Resultado de `ssh.exec`. */
export interface SshExecResult {
  readonly codigo: number;
  readonly saida: string;
  readonly erro: string;
  readonly duracaoMs: number;
  /** Snapshot da Hostinger feito antes do comando (RF-508). */
  readonly snapshot?: string;
}

/** Pasta remota (`fakl-ssh://host/caminho`) aberta no workspace da IDE. */
export interface SshRemoteRoot {
  /** Alias do host (veja `ssh.hosts.list`). */
  readonly host: string;
  /** Caminho absoluto da pasta no servidor. */
  readonly caminho: string;
}

/** `ssh.read` */
export interface SshReadResult {
  readonly conteudo: string;
  readonly codificacao: 'utf8' | 'base64';
  /** Bytes lidos (pode ser menos que o arquivo quando `truncado`). */
  readonly bytes: number;
  readonly truncado: boolean;
}

/** `ssh.write` */
export interface SshWriteResult {
  readonly bytes: number;
  /** Snapshot da Hostinger feito antes da escrita (RF-508). */
  readonly snapshot?: string;
}

export type SshEntryKind = 'file' | 'dir' | 'other';

/** `ssh.list` */
export interface SshListResult {
  readonly entradas: readonly { readonly nome: string; readonly tipo: SshEntryKind }[];
  readonly truncado: boolean;
}

/** `ssh.stat` */
export interface SshStatResult {
  readonly existe: boolean;
  readonly tipo?: SshEntryKind;
  readonly tamanho?: number;
  /** Segundos desde 1970. */
  readonly modificadoEm?: number;
}

export type SshForwardState = 'abrindo' | 'ativo' | 'reconectando' | 'erro' | 'fechado';

/** Encaminhamento de porta (`ssh.forward.list`, evento `ssh.forward`): RF-504. */
export interface SshForwardInfo {
  /** `<host>:<portaLocal>`; a porta local é única entre os encaminhamentos. */
  readonly id: string;
  /** Alias do host do inventário. */
  readonly host: string;
  /** Sempre um endereço de loopback: o encaminhamento não fica visível na rede. */
  readonly bind: string;
  readonly portaLocal: number;
  /** Endereço do destino, visto do servidor (padrão `127.0.0.1`). */
  readonly destino: string;
  readonly portaDestino: number;
  readonly estado: SshForwardState;
  readonly erro?: string;
  /** Reabre sozinho se a conexão cair. */
  readonly reconectar: boolean;
  /** Guardado nos favoritos (sobrevive ao Core, mas nunca reabre sozinho). */
  readonly favorito: boolean;
  /** Quando ficou ativo (ISO 8601). */
  readonly desde?: string;
  /** Reconexões desde o último estado ativo. */
  readonly tentativas: number;
  /** Endereço para abrir no navegador. */
  readonly url: string;
}

/** `hostinger.status` */
export interface HostingerStatus {
  readonly conectado: boolean;
  readonly erro?: string;
}

/** Projeto Lovable ligado a um repositório (SDD 11.4). */
export interface LovableProject {
  /** Repositório do GitHub, `dono/nome`. */
  readonly repo: string;
  /** Endereço do projeto no Lovable. */
  readonly url: string;
  /** Branch que o Lovable acompanha; padrão `main`. */
  readonly branch?: string;
}
