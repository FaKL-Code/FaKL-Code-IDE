import type {
  AgentChangedFile,
  AgentProfileAvailability,
  AgentSessionInfo,
  CostSummary,
  PermissionPolicyName,
} from '@fakl/protocol';

import type { ChatItem } from '@fakl/conversa';
import type { FromVoz, ToVoz } from './voz-protocol.js';
import type { MesaLayout, MesaRole } from './webview/mesa-model.js';

/** Mensagens da extensão para a Mesa (webview). */
export type ToMesa =
  | {
      readonly type: 'init';
      readonly layout: MesaLayout;
      readonly hasFolder: boolean;
      readonly profiles: readonly AgentProfileAvailability[];
    }
  | {
      readonly type: 'sessions';
      readonly sessions: readonly AgentSessionInfo[];
      readonly roles: readonly MesaRole[];
    }
  | { readonly type: 'profiles'; readonly profiles: readonly AgentProfileAvailability[] }
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
      readonly files?: readonly AgentChangedFile[];
      readonly branch?: string;
    }
  /** Um agente criado pela Mesa: o cartão vai para onde o usuário clicou. */
  | {
      readonly type: 'started';
      readonly sessionId: string;
      /** Sem posição, o cartão fica onde a Mesa achar lugar livre. */
      readonly at?: { readonly x: number; readonly y: number };
    }
  | { readonly type: 'focus'; readonly sessionId: string }
  /** Gasto do dia por provedor, para os anéis de uso. */
  | { readonly type: 'usage'; readonly summary: CostSummary }
  /** Arquivos da pasta que batem com o que foi digitado depois de #. */
  | { readonly type: 'files'; readonly requestId: number; readonly files: readonly string[] }
  | { readonly type: 'error'; readonly text: string }
  | { readonly type: 'offline' }
  /** Status da voz e transcrições do microfone dos cartões. */
  | ToVoz;

/** Mensagens da Mesa para a extensão. */
export type FromMesa =
  | { readonly type: 'ready' }
  | { readonly type: 'saveLayout'; readonly layout: MesaLayout }
  | {
      readonly type: 'start';
      readonly profileId: string;
      readonly worktree: boolean;
      readonly permissions?: PermissionPolicyName;
      readonly at?: { readonly x: number; readonly y: number };
    }
  | {
      readonly type: 'send';
      readonly sessionId: string;
      readonly text: string;
      /** O que você digitou, sem as respostas anexadas pelas @menções. */
      readonly shown?: string;
    }
  | {
      readonly type: 'permission';
      readonly sessionId: string;
      readonly id: string;
      readonly allow: boolean;
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
  | { readonly type: 'pause' | 'resume' | 'stop'; readonly sessionId: string }
  | { readonly type: 'changes'; readonly sessionId: string }
  | { readonly type: 'openDiff'; readonly sessionId: string; readonly path: string }
  | {
      readonly type: 'applyFiles' | 'rejectFiles';
      readonly sessionId: string;
      readonly paths: readonly string[];
    }
  | { readonly type: 'openChat' | 'terminal' | 'log'; readonly sessionId: string }
  | { readonly type: 'command'; readonly command: MesaCommand }
  | { readonly type: 'findFiles'; readonly requestId: number; readonly query: string }
  | { readonly type: 'openExternal'; readonly url: string }
  | { readonly type: 'clearFinished' }
  | FromVoz;

/** Comandos da IDE que a barra de ferramentas da Mesa dispara. */
export const MESA_COMMANDS = {
  tarefa: 'fakl.tasks.new',
  cafe: 'fakl.cafe.open',
  custos: 'fakl.costs.show',
  vault: 'fakl.vault.graph',
  perfis: 'fakl.profiles.new',
  remoto: 'fakl.remote.menu',
  foco: 'fakl.mesa.focus',
  voz: 'fakl.voz.falar',
} as const;

export type MesaCommand = keyof typeof MESA_COMMANDS;
