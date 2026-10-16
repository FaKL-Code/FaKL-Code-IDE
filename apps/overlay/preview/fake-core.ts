/**
 * Ponte de mentira para a prévia: faz o papel do processo principal e do Core
 * ao mesmo tempo. Responde aos pedidos JSON-RPC com agentes em vários estados,
 * permissões, uma decisão do maestro e um agente parado no limite, e manda
 * eventos ao vivo para o pet mudar.
 */
import type {
  AgentPermissionRequest,
  AgentProfileEntry,
  AgentSessionInfo,
  AgentTranscriptResult,
  ChatItem,
  ClaudeAccountSlot,
  ClaudeAccountsState,
  CostSummary,
  Decision,
  FaklEvent,
  JsonRpcRequest,
  ProviderWindows,
  Run,
  Task,
} from '@fakl/protocol';

import type {
  BalloonSide,
  OverlayBridge,
  OverlayCommand,
  OverlayShape,
  OverlayStatus,
} from '../src/bridge.js';

const now = Date.now();
const iso = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();

const usage = (
  input: number,
  output: number,
  cost?: number,
  context?: [number, number],
): AgentSessionInfo['usage'] => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD' } }),
  ...(context ? { context: { used: context[0], size: context[1] } } : {}),
});

const base = { opcoes: [], permissoes: 'perguntar' as const };
const params = new URLSearchParams(location.search);
const calm = params.get('cenario') === 'calmo';

let agents: AgentSessionInfo[] = [
  {
    ...base,
    sessionId: 's1',
    profileId: 'claude',
    nome: 'Claude Code',
    titulo: 'Total do carrinho com cupom',
    contaClaude: { slot: 1, apelido: 'Pessoal' },
    cwd: 'C:/dev/loja',
    state: 'executando',
    usage: usage(152_000, 18_400, 2.84, [84_000, 200_000]),
    iniciadaEm: iso(42),
    atividadeEm: iso(0),
    ultimaFala: 'Agora vou rodar os testes do carrinho para conferir a correção.',
    opcoes: [
      {
        id: 'model',
        nome: 'Modelo',
        categoria: 'model',
        atual: 'opus',
        valores: [
          { id: 'opus', nome: 'Opus' },
          { id: 'sonnet', nome: 'Sonnet' },
        ],
      },
    ],
  },
  {
    ...base,
    sessionId: 's2',
    profileId: 'codex',
    nome: 'Codex',
    cwd: 'C:/dev/api',
    titulo: 'Migração da tabela de pedidos',
    state: calm ? 'executando' : 'aguardando-permissão',
    usage: usage(61_000, 7_200, undefined, [41_000, 272_000]),
    iniciadaEm: iso(18),
    atividadeEm: iso(1),
    ultimaFala: 'Preciso rodar a migração no banco local.',
  },
  {
    ...base,
    sessionId: 's3',
    profileId: 'gemini',
    nome: 'Gemini CLI',
    cwd: 'C:/dev/site',
    titulo: 'Cabeçalho no tema escuro',
    state: 'ocioso',
    permissoes: 'autopilot',
    usage: usage(22_000, 3_100),
    iniciadaEm: iso(80),
    atividadeEm: iso(25),
    ultimaFala: 'Pronto: o cabeçalho agora segue o tema escuro.',
  },
  {
    ...base,
    sessionId: 's4',
    profileId: 'claude',
    nome: 'Maestro',
    cwd: 'C:/Users/dev/.fakl/worktrees/loja/t1',
    pastaOrigem: 'C:/dev/loja',
    worktree: { path: 'C:/Users/dev/.fakl/worktrees/loja/t1', branch: 'fakl/t1/maestro' },
    titulo: 'Checkout em uma página',
    taskId: 't1',
    contaClaude: { slot: 1, apelido: 'Pessoal' },
    state: 'pensando',
    usage: usage(98_000, 9_900, 1.12, [176_000, 200_000]),
    iniciadaEm: iso(12),
    atividadeEm: iso(0),
    ultimaFala: 'Dividi a tarefa em duas partes; o revisor entra depois.',
  },
  {
    ...base,
    sessionId: 's5',
    profileId: 'claude',
    nome: 'Revisor',
    cwd: 'C:/dev/docs',
    titulo: 'Revisar o guia de instalação',
    contaClaude: { slot: 1, apelido: 'Pessoal' },
    state: calm ? 'ocioso' : 'pausado',
    // O limite de antes de o overlay abrir: só o Core guardou.
    ...(calm
      ? {}
      : {
          limite: {
            motivo: 'Claude AI usage limit reached. Your limit will reset at 7pm.',
            em: iso(7),
          },
        }),
    usage: usage(410_000, 32_000, 6.1, [140_000, 200_000]),
    iniciadaEm: iso(95),
    atividadeEm: iso(7),
    ultimaFala: 'Revisei 4 de 7 seções.',
  },
  ...[
    ['s6', 'claude', 'Claude Code', 'concluído', 95, 'Atualizar o README'],
    ['s7', 'codex', 'Codex', 'falhou', 130, 'Script de deploy'],
    ['s8', 'gemini', 'Gemini CLI', 'parado', 300, 'Ícones novos'],
  ].map(([id, profileId, nome, state, ago, titulo]): AgentSessionInfo => ({
    ...base,
    sessionId: String(id),
    profileId: String(profileId),
    nome: String(nome),
    titulo: String(titulo),
    cwd: 'C:/dev/loja',
    state: state as AgentSessionInfo['state'],
    usage: usage(30_000, 4_000, 0.4),
    iniciadaEm: iso(Number(ago) + 30),
    atividadeEm: iso(Number(ago)),
    encerradaEm: iso(Number(ago)),
    ultimaFala: 'Terminei.',
    // O Core reabre uma sessão retomável quando chega uma mensagem.
    ...(id === 's6' ? { retomavel: true } : {}),
  })),
];

let permissions: AgentPermissionRequest[] = calm
  ? []
  : [
      {
        sessionId: 's2',
        id: 'p1',
        title: 'Executar `pnpm db:migrate` em C:/dev/api',
        detail: 'comando: pnpm db:migrate\ncwd: C:/dev/api',
        options: [
          { id: 'allow', name: 'Permitir', kind: 'allow_once' },
          { id: 'always', name: 'Permitir sempre', kind: 'allow_always' },
          { id: 'reject', name: 'Negar', kind: 'reject_once' },
        ],
      },
    ];

/** Janelas dos planos como o Core lê dos registros dos CLIs. */
const windows: ProviderWindows[] = [
  {
    provedor: 'anthropic',
    nome: 'Pessoal',
    sessao: { tokens: 380_000, resetaEm: Date.now() + 2 * 3_600_000 + 15 * 60_000 },
    semana: { tokens: 4_200_000 },
    origem: 'estimado',
  },
  {
    provedor: 'openai',
    sessao: { fracao: 0.42, resetaEm: Date.now() + 95 * 60_000 },
    semana: { fracao: 0.18, resetaEm: Date.now() + 3 * 24 * 3_600_000 },
    origem: 'real',
  },
];

const transcript: ChatItem[] = [
  { kind: 'user', text: 'O total do carrinho está errado quando tem cupom. Corrige?' },
  { kind: 'thought', text: 'Vou procurar onde o desconto é aplicado.' },
  { kind: 'tool', id: 't1', title: 'Ler src/carrinho/total.ts', status: 'completed' },
  { kind: 'tool', id: 't2', title: 'Buscar "aplicarCupom"', status: 'completed' },
  {
    kind: 'agent',
    text: [
      'O cupom é aplicado **antes** do frete, mas a regra diz que vale só sobre os itens.',
      '',
      '```ts',
      'return aplicarCupom(subtotal, cupom) + frete(itens);',
      '```',
    ].join('\n'),
  },
  { kind: 'tool', id: 't3', title: 'Editar src/carrinho/total.ts', status: 'completed' },
  { kind: 'permission', id: 'px', title: 'Executar `pnpm test carrinho`', answer: 'permitido' },
  { kind: 'tool', id: 't4', title: 'pnpm test carrinho', status: 'in_progress' },
];

const tasks: Task[] = [
  {
    id: 't1',
    titulo: 'Checkout em uma página',
    repoPath: 'C:/dev/loja',
    status: 'executando',
    criadaEm: iso(14),
    runs: ['r1'],
  },
  {
    id: 't2',
    titulo: 'Atualizar dependências do site',
    repoPath: 'C:/dev/site',
    status: 'concluída',
    criadaEm: iso(600),
    runs: ['r2'],
  },
];

const runs: Run[] = [
  {
    id: 'r1',
    taskId: 't1',
    status: 'aguardando-decisão',
    inicio: iso(13),
    branch: 'fakl/t1',
    maestroSessionId: 's4',
    agentes: [
      { sessionId: 's4', profileId: 'claude', papel: 'maestro', profundidade: 0 },
      { sessionId: 's1', profileId: 'claude', papel: 'executor', profundidade: 1 },
    ],
    rodadas: [{ numero: 2, inicio: iso(8), veredito: 'falhou', verificacoes: [] }],
    decisoes: [],
  },
  {
    id: 'r2',
    taskId: 't2',
    status: 'concluída',
    inicio: iso(600),
    fim: iso(560),
    branch: 'fakl/t2',
    maestroSessionId: 's9',
    agentes: [],
    rodadas: [{ numero: 1, inicio: iso(590), veredito: 'passou', verificacoes: [] }],
    decisoes: [],
  },
];

let decisions: Decision[] = calm
  ? []
  : [
      {
        id: 'd1',
        runId: 'r1',
        pergunta: 'Os testes falharam na rodada 2. Tentar de novo com o revisor?',
        opcoes: [
          { id: 'sim', rotulo: 'Tentar de novo' },
          { id: 'nao', rotulo: 'Parar aqui' },
        ],
        criadaEm: iso(2),
      },
    ];

const summary: CostSummary = {
  dia: new Date().toISOString().slice(0, 10),
  total: { tokensEntrada: 2_310_000, tokensSaida: 190_000, custoUsd: 14.3 },
  porProvedor: {
    anthropic: { tokensEntrada: 410_000, tokensSaida: 52_000, custoUsd: 17.6 },
    openai: { tokensEntrada: 1_780_000, tokensSaida: 120_000, custoUsd: 0 },
    google: { tokensEntrada: 120_000, tokensSaida: 18_000, custoUsd: 0 },
  },
  porSessao: {},
  tetos: { anthropic: { custoUsd: 20 }, openai: { tokens: 4_000_000 } },
  bloqueados: [],
};

const noUse = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
let claude: ClaudeAccountsState = {
  ativa: 1,
  contas: [
    {
      slot: 1,
      apelido: 'Pessoal',
      dir: 'C:/Users/dev/.fakl/accounts/claude/1',
      logada: true,
      plano: 'Max',
      ativa: true,
      uso: { tokensEntrada: 1_840_000, tokensSaida: 152_000, custoUsd: 0 },
    },
    {
      slot: 2,
      apelido: 'Trabalho',
      dir: 'C:/Users/dev/.fakl/accounts/claude/2',
      logada: true,
      plano: 'Pro',
      ativa: false,
      uso: noUse,
    },
  ],
};

const profiles: AgentProfileEntry[] = [
  ['claude', 'Claude Code', 'anthropic'],
  ['codex', 'Codex', 'openai'],
  ['gemini', 'Gemini CLI', 'google'],
].map(([id, nome, provedor]) => ({
  arquivo: `${String(id)}.yaml`,
  profile: { id: String(id), nome: String(nome), provedor: String(provedor), adaptador: 'acp' },
}));

let eventId = 0;
const nextId = (): string => `01ZZZZZZZZZZZZZZZZ${String(++eventId).padStart(8, '0')}`;

/** Registro das chamadas que precisam da IDE, para conferir na prévia. */
export const calls: string[] = [];

export class FakeCore implements OverlayBridge {
  private readonly frames = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: OverlayStatus) => void>();
  private readonly commands = new Set<(command: OverlayCommand) => void>();
  private readonly quietListeners = new Set<(quiet: boolean) => void>();
  mode: OverlayShape = 'pet';
  onModeChange: (mode: OverlayShape) => void = () => undefined;
  /** `?lado=direita` simula o pet preso à borda esquerda da tela. */
  readonly side: BalloonSide = params.get('lado') === 'direita' ? 'direita' : 'esquerda';
  /** Como no principal: o "Não perturbe" mora fora da página. */
  quiet = false;
  /** O último pedido de deixar os cliques passarem pela área vazia. */
  clickThrough = false;

  send(frame: string): void {
    const request = JSON.parse(frame) as JsonRpcRequest;
    const result = this.answer(request.method, (request.params ?? {}) as Record<string, unknown>);
    setTimeout(() => {
      this.reply(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }, 30);
  }

  onFrame(listener: (frame: string) => void): void {
    this.frames.add(listener);
  }

  onStatus(listener: (status: OverlayStatus) => void): void {
    this.statuses.add(listener);
    if (params.has('offline')) {
      setTimeout(() => {
        listener('offline');
      }, 50);
      return;
    }
    setTimeout(() => {
      listener('online');
      this.stream();
    }, 50);
  }

  setMode(mode: OverlayShape): void {
    this.mode = mode;
    this.clickThrough = false;
    this.onModeChange(mode);
  }

  onSide(listener: (side: BalloonSide) => void): void {
    setTimeout(() => {
      listener(this.side);
    }, 0);
  }

  setClickThrough(through: boolean): void {
    if (this.mode === 'balao') this.clickThrough = through;
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    for (const listener of this.quietListeners) listener(quiet);
  }

  onQuiet(listener: (quiet: boolean) => void): void {
    this.quietListeners.add(listener);
    setTimeout(() => {
      listener(this.quiet);
    }, 0);
  }

  hide(): void {
    calls.push('hide');
  }

  quit(): void {
    calls.push('quit');
  }

  onCommand(listener: (command: OverlayCommand) => void): void {
    this.commands.add(listener);
  }

  /** O que o atalho global e a bandeja fariam. */
  command(command: OverlayCommand): void {
    for (const listener of this.commands) listener(command);
  }

  private reply(frame: string): void {
    for (const listener of this.frames) listener(frame);
  }

  private emit(event: Omit<FaklEvent, 'id' | 'ts'>): void {
    const full: FaklEvent = { ...event, id: nextId(), ts: new Date().toISOString() };
    this.reply(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'events.event',
        params: { subscriptionId: 'x', event: full },
      }),
    );
  }

  private setState(sessionId: string, state: AgentSessionInfo['state']): void {
    const before = agents.find((a) => a.sessionId === sessionId)?.state ?? 'ocioso';
    agents = agents.map((a) =>
      a.sessionId === sessionId ? { ...a, state, atividadeEm: new Date().toISOString() } : a,
    );
    this.emit({ topic: 'agent.state', subject: sessionId, data: { state, previous: before } });
  }

  private answer(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'agents.list':
        return agents;
      case 'agents.permissions':
        return permissions;
      case 'agents.transcript': {
        const result: AgentTranscriptResult =
          p.sessionId === 's1'
            ? { items: transcript, omitidos: 0, ultimoEvento: '00' }
            : { items: [{ kind: 'agent', text: 'Oi! Em que posso ajudar?' }], omitidos: 0 };
        return result;
      }
      case 'tasks.list':
        return tasks;
      case 'tasks.get':
        return { runs: runs.filter((r) => r.taskId === p.taskId) };
      case 'runs.decisions':
        return decisions;
      case 'runs.decide':
        decisions = decisions.filter((d) => d.id !== p.decisionId);
        return null;
      case 'agents.permission':
        calls.push(`agents.permission ${JSON.stringify(p)}`);
        permissions = permissions.filter((x) => x.id !== p.id);
        setTimeout(() => {
          this.setState(String(p.sessionId), p.allow ? 'executando' : 'ocioso');
        }, 100);
        return null;
      case 'agents.resume':
        setTimeout(() => {
          this.setState(String(p.sessionId), 'executando');
        }, 100);
        return null;
      case 'agents.pause':
        setTimeout(() => {
          this.setState(String(p.sessionId), 'pausado');
        }, 100);
        return null;
      case 'agents.stop':
        setTimeout(() => {
          this.setState(String(p.sessionId), 'parado');
        }, 100);
        return null;
      case 'agents.send':
        setTimeout(() => {
          this.emit({
            topic: 'agent.prompt',
            subject: String(p.sessionId),
            data: { text: p.message },
          });
        }, 50);
        return null;
      case 'costs.summary':
        return summary;
      case 'usage.windows':
        return { janelas: windows };
      case 'profiles.list':
        return profiles;
      case 'claude.accounts.list':
        return claude;
      case 'claude.accounts.setActive': {
        const slot = (p.slot ?? null) as ClaudeAccountSlot | null;
        claude = {
          ...(slot ? { ativa: slot } : {}),
          contas: claude.contas.map((c) => ({ ...c, ativa: c.slot === slot })),
        };
        return claude;
      }
      case 'ui.reveal':
        calls.push(`ui.reveal ${JSON.stringify(p)}`);
        return null;
      default:
        return null;
    }
  }

  /** O Revisor bate o limite da sessão, o s1 escreve e o maestro termina de pensar. */
  private stream(): void {
    if (!calm) {
      setTimeout(() => {
        this.emit({
          topic: 'agent.output',
          subject: 's5',
          data: {
            kind: 'error',
            text: 'Claude AI usage limit reached. Your limit will reset at 7pm.',
          },
        });
      }, 300);
    }
    ['Os testes do carrinho ', 'passaram: **12 de 12**.'].forEach((text, index) => {
      setTimeout(
        () => {
          this.emit({ topic: 'agent.output', subject: 's1', data: { kind: 'message', text } });
        },
        900 + index * 400,
      );
    });
    setTimeout(() => {
      this.setState('s3', 'executando');
    }, 1_400);
    setTimeout(() => {
      this.setState('s4', 'ocioso');
    }, 2_400);
  }
}
