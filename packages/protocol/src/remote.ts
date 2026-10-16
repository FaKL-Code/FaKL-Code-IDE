/** Controle remoto (SDD 12): o que a IDE vê do gateway do Core. */
export type RemoteScopeName = 'ver' | 'decidir' | 'comandar' | 'editor';

export interface RemoteStatus {
  readonly ligado: boolean;
  readonly estado: 'desligado' | 'conectando' | 'ligado' | 'erro';
  readonly relay?: string;
  readonly erro?: string;
  /** Aparelhos com canal aberto agora. */
  readonly conectados: number;
  readonly aparelhos: number;
  readonly pareamentoExpiraEm?: string;
}

export interface RemoteDeviceInfo {
  readonly id: string;
  readonly nome: string;
  readonly escopos: readonly RemoteScopeName[];
  readonly criadoEm: string;
  readonly ultimoAcesso?: string;
  readonly conectado: boolean;
  /** Recebe notificações push. */
  readonly push: boolean;
}

/** Resposta de `remote.pair.begin`: o link vai no QR code. */
export interface RemotePairingInfo {
  readonly pairingId: string;
  readonly url: string;
  readonly expiraEm: string;
  /** Impressão da chave do Core, para conferir no aparelho. */
  readonly impressao: string;
}

/** Dados de `remote.device`. */
export type RemoteDeviceEventData =
  | {
      readonly tipo: 'pedido';
      readonly pairingId: string;
      readonly nome: string;
      readonly impressao: string;
    }
  | {
      readonly tipo: 'pareado' | 'conectado' | 'desconectado' | 'revogado';
      readonly aparelho: RemoteDeviceInfo;
    };

/**
 * `remote.test`: confere um relay sem mexer na conexão atual. Sem parâmetros,
 * testa o relay e a chave do config.yaml.
 */
export interface RemoteTestParams {
  readonly relay?: string;
  /** FAKL_RELAY_KEY; sem ela (e com `relay`), vale a do config.yaml. */
  readonly chave?: string;
}

/** Onde o teste parou: o endereço, o HTTPS (`/saude`), o WebSocket ou a chave. */
export type RemoteTestStep = 'endereco' | 'https' | 'websocket' | 'chave';

export interface RemoteTestResult {
  readonly ok: boolean;
  readonly relay?: string;
  /** Etapa que falhou (só quando `ok` é false). */
  readonly etapa?: RemoteTestStep;
  /** Resultado em pt-BR, pronto para mostrar. */
  readonly mensagem: string;
  /** Algo a corrigir mesmo com o teste passando (ex.: relay sem FAKL_RELAY_KEY). */
  readonly aviso?: string;
  /** O relay tem as chaves VAPID: as notificações push funcionam. */
  readonly push?: boolean;
  /** Tempo da conexão WebSocket até a resposta do relay. */
  readonly latenciaMs?: number;
}
