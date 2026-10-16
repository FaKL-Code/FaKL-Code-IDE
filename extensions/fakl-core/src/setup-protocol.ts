/**
 * Mensagens entre a jornada de configuração (webview) e a extensão. O host
 * calcula tudo (o que está feito, o que falta, os botões) e a página só
 * desenha e devolve cliques.
 */

import type { PermissionPolicyName } from '@fakl/protocol';

export const SETUP_STEP_IDS = [
  'idioma',
  'importar',
  'tema',
  'ia',
  'permissoes',
  'github',
  'fontes',
  'vault',
  'ssh',
  'hostinger',
  'lovable',
  'email',
  'remoto',
  'voz',
  'sync',
  'cli',
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** Essenciais aparecem sempre; integrações, só as que a pessoa marcou no início. */
export type SetupGroup = 'essencial' | 'integracao';

/** `indisponivel`: depende do Core, que ainda não respondeu. */
export type SetupStepState = 'feito' | 'pendente' | 'pulado' | 'indisponivel';

export interface SetupAction {
  /** Comando do VS Code ou ação interna da jornada (`tema.aplicar`, `cli.path`...). */
  readonly id: string;
  readonly rotulo: string;
  readonly principal?: boolean;
}

export interface SetupStepView {
  readonly id: SetupStepId;
  readonly grupo: SetupGroup;
  readonly titulo: string;
  readonly resumo: string;
  readonly estado: SetupStepState;
  /** O que já está configurado ou o que falta, em uma linha. */
  readonly detalhe?: string;
  readonly acoes: readonly SetupAction[];
  /** Integração marcada pela pessoa (essenciais: sempre). */
  readonly escolhida: boolean;
}

export type ProviderActionId = 'instalar' | 'login' | 'chave' | 'removerChave';

export interface SetupProviderRow {
  readonly id: string;
  readonly nome: string;
  readonly pronto: boolean;
  /** "pronto por assinatura · v2.1 · perfis: claude" */
  readonly linha: string;
  readonly aviso?: string;
  readonly acoes: readonly { readonly id: ProviderActionId; readonly rotulo: string }[];
}

export interface SetupPermissionOption {
  readonly id: PermissionPolicyName;
  readonly rotulo: string;
  readonly descricao: string;
}

export interface SetupCap {
  readonly provedor: string;
  readonly nome: string;
  readonly custoUsd?: number;
}

export interface SetupView {
  readonly conectado: boolean;
  readonly etapas: readonly SetupStepView[];
  /** Linhas do passo de IA; sem o Core, ausente. */
  readonly provedores?: readonly SetupProviderRow[];
  readonly permissoes?: {
    readonly atual: PermissionPolicyName;
    readonly opcoes: readonly SetupPermissionOption[];
    readonly tetos: readonly SetupCap[];
  };
  /** A pessoa já escolheu as integrações (a tela de início já passou). */
  readonly interessesEscolhidos: boolean;
  /** Etapa para abrir direto (comando "Configurar" com argumento). */
  readonly abrir?: SetupStepId;
}

export interface ToSetup {
  readonly type: 'view';
  readonly view: SetupView;
}

export type FromSetup =
  | { readonly type: 'ready' }
  | { readonly type: 'acao'; readonly etapa: SetupStepId; readonly acao: string }
  | { readonly type: 'provedor'; readonly acao: ProviderActionId; readonly id: string }
  | { readonly type: 'detectar' }
  | { readonly type: 'pular'; readonly etapa: SetupStepId }
  | { readonly type: 'interesses'; readonly ids: readonly SetupStepId[] }
  | { readonly type: 'permissoes'; readonly modo: PermissionPolicyName }
  | { readonly type: 'teto'; readonly provedor: string; readonly custoUsd: number | null }
  | { readonly type: 'concluir' };
