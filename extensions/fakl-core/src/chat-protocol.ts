import type {
  AgentChangedFile,
  AgentProfileAvailability,
  AgentSessionInfo,
  CostSummary,
  PermissionPolicyName,
} from '@fakl/protocol';

import type { ChatItem } from '@fakl/conversa';

import type { FromVoz, ToVoz } from './voz-protocol.js';

/** Mensagens da extensão para o chat (webview). */
export type ToChat =
  | {
      readonly type: 'profiles';
      readonly profiles: readonly AgentProfileAvailability[];
      readonly hasFolder: boolean;
    }
  | {
      readonly type: 'sessions';
      readonly sessions: readonly AgentSessionInfo[];
      /** Sessão aberta no chat; sem ela, o chat está numa conversa nova. */
      readonly selected?: string;
    }
  | { readonly type: 'transcript'; readonly sessionId: string; readonly items: readonly ChatItem[] }
  | {
      readonly type: 'patch';
      readonly sessionId: string;
      readonly index: number;
      readonly item: ChatItem;
    }
  | {
      readonly type: 'changes';
      readonly sessionId: string;
      /** Ausente quando o agente trabalha direto na pasta aberta. */
      readonly files?: readonly AgentChangedFile[];
      readonly branch?: string;
    }
  /** Gasto do dia por provedor, para os anéis de uso. */
  | { readonly type: 'usage'; readonly summary: CostSummary }
  /** Arquivos da pasta que batem com a busca do menu @ ou #, e o arquivo aberto no editor. */
  | {
      readonly type: 'files';
      readonly requestId: number;
      readonly files: readonly string[];
      readonly active?: string;
    }
  | { readonly type: 'error'; readonly text: string }
  /** Status da voz e transcrições do microfone do compositor. */
  | ToVoz;

/** Mensagens do chat para a extensão. */
export type FromChat =
  | { readonly type: 'ready' }
  | { readonly type: 'select'; readonly sessionId?: string }
  | {
      readonly type: 'send';
      readonly text: string;
      /** Sessão existente, ou um agente novo com o perfil e o lugar escolhidos. */
      readonly sessionId?: string;
      readonly profileId?: string;
      readonly worktree?: boolean;
      /** Modo da conversa nova; ausente, vale o do perfil ou do config.yaml. */
      readonly permissions?: PermissionPolicyName;
    }
  | {
      readonly type: 'setOption';
      readonly sessionId: string;
      readonly id: string;
      readonly value: string | boolean;
    }
  | {
      readonly type: 'setPermissions';
      readonly sessionId: string;
      readonly permissions: PermissionPolicyName;
    }
  | {
      readonly type: 'setAutoResume';
      readonly sessionId: string;
      readonly automatica: boolean;
    }
  | {
      readonly type: 'permission';
      readonly sessionId: string;
      readonly id: string;
      readonly allow: boolean;
    }
  | { readonly type: 'pause' | 'resume' | 'stop'; readonly sessionId: string }
  | { readonly type: 'refreshProfiles' }
  | { readonly type: 'openDiff'; readonly sessionId: string; readonly path: string }
  | {
      readonly type: 'applyFiles' | 'rejectFiles';
      readonly sessionId: string;
      readonly paths: readonly string[];
    }
  | { readonly type: 'install'; readonly profileId: string }
  | { readonly type: 'findFiles'; readonly requestId: number; readonly query: string }
  /** Abre a Mesa, já na conversa indicada quando há. */
  | { readonly type: 'openMesa'; readonly sessionId?: string }
  | FromVoz;
