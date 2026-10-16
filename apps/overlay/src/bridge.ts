/**
 * Contrato entre o overlay e o processo principal (docs/ux/modo-minimizado.md).
 * O preload expõe `window.faklOverlay`; a página nunca vê socket nem token.
 */

export type OverlayMode = 'pet' | 'painel';
/** Forma da janela: `balao` é o pet com espaço ao lado para o balão. */
export type OverlayShape = OverlayMode | 'balao';
/** Lado do pet para onde o balão abre (o do centro da tela). */
export type BalloonSide = 'esquerda' | 'direita';
export type OverlayStatus = 'online' | 'offline';
export type OverlayCommand = 'compor' | 'painel' | 'pet';

export interface OverlayBridge {
  /** Uma mensagem JSON-RPC para o Core, sem o `\n` (a conexão já está autenticada). */
  send(frame: string): void;
  /** Mensagens do Core, uma por chamada, sem o `\n`. */
  onFrame(listener: (frame: string) => void): void;
  /** `online` depois do `session.hello`; `offline` quando o Core cai (o principal reconecta). */
  onStatus(listener: (status: OverlayStatus) => void): void;
  /** Troca a forma: o principal redimensiona e reposiciona a janela. */
  setMode(mode: OverlayShape): void;
  /** Lado do balão; o principal reenvia ao carregar e sempre que o pet muda de borda. */
  onSide(listener: (side: BalloonSide) => void): void;
  /**
   * Com o balão, `true` quando o ponteiro está na área vazia da janela: ali os
   * cliques passam para o programa de baixo (no Linux, não passam).
   */
  setClickThrough(through: boolean): void;
  /** "Não perturbe": o principal guarda (junto com a posição) e avisa a bandeja. */
  setQuiet(quiet: boolean): void;
  /** O valor atual ao carregar e cada mudança, venha do painel ou da bandeja. */
  onQuiet(listener: (quiet: boolean) => void): void;
  /** Esconde o overlay (fica na bandeja). */
  hide(): void;
  /** Sai do FaKL-Code, com o diálogo de agentes trabalhando. */
  quit(): void;
  /** O principal pede uma forma (atalho global abre o compositor). */
  onCommand(listener: (command: OverlayCommand) => void): void;
}

/** Canais IPC; `ready` avisa o principal para reenviar o estado da conexão. */
export const OverlayChannels = {
  send: 'fakl-overlay:send',
  mode: 'fakl-overlay:mode',
  clickThrough: 'fakl-overlay:click-through',
  setQuiet: 'fakl-overlay:set-quiet',
  hide: 'fakl-overlay:hide',
  quit: 'fakl-overlay:quit',
  ready: 'fakl-overlay:ready',
  frame: 'fakl-overlay:frame',
  status: 'fakl-overlay:status',
  command: 'fakl-overlay:command',
  side: 'fakl-overlay:side',
  quiet: 'fakl-overlay:quiet',
} as const;

declare global {
  interface Window {
    faklOverlay?: OverlayBridge;
  }
}
