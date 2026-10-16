/**
 * `@fakl/remote` de mentira para a prévia: tudo do pacote real, menos a
 * sessão, que responde com uma IDE inventada e manda eventos ao vivo.
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
  Run,
  Task,
} from '@fakl/protocol';
import { isFinalAgentState } from '@fakl/protocol';
import { RemoteError, type DeviceTarget, type KeyPair } from '@fakl/remote';

export * from '@fakl/remote';

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

const agents: AgentSessionInfo[] = [
  {
    ...base,
    sessionId: 's1',
    profileId: 'claude',
    nome: 'Claude Code',
    contaClaude: { slot: 1, apelido: 'Pessoal' },
    cwd: 'C:/Users/dev/.fakl/worktrees/loja/s1',
    worktree: { path: 'C:/Users/dev/.fakl/worktrees/loja/s1', branch: 'fakl/avulso/s1' },
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
    state: 'aguardando-permissão',
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
    nome: 'Claude Code',
    cwd: 'C:/Users/dev/.fakl/worktrees/loja/t1',
    worktree: { path: 'C:/Users/dev/.fakl/worktrees/loja/t1', branch: 'fakl/t1/maestro' },
    taskId: 't1',
    state: 'pensando',
    usage: usage(98_000, 9_900, 1.12, [120_000, 200_000]),
    iniciadaEm: iso(12),
    atividadeEm: iso(0),
    ultimaFala: 'Dividi a tarefa em duas partes; o revisor entra depois.',
  },
  ...[
    ['s5', 'claude', 'Claude Code', 'concluído', 95],
    ['s6', 'codex', 'Codex', 'falhou', 130],
    ['s7', 'gemini', 'Gemini CLI', 'parado', 300],
    ['s8', 'claude', 'Claude Code', 'parado', 1500],
  ].map(([id, profileId, nome, state, ago]): AgentSessionInfo => ({
    ...base,
    sessionId: String(id),
    profileId: String(profileId),
    nome: String(nome),
    cwd: 'C:/dev/loja',
    state: state as AgentSessionInfo['state'],
    usage: usage(30_000, 4_000, 0.4),
    iniciadaEm: iso(Number(ago) + 30),
    atividadeEm: iso(Number(ago)),
    encerradaEm: iso(Number(ago)),
    ultimaFala: 'Terminei.',
  })),
];

const permissions: AgentPermissionRequest[] = [
  {
    sessionId: 's2',
    id: 'p1',
    title: 'Executar `pnpm db:migrate` em C:/dev/api',
    options: [],
  },
];

const transcript: ChatItem[] = [
  { kind: 'notice', text: 'Trabalhando no branch fakl/avulso/s1.', tone: 'info' },
  { kind: 'user', text: 'O total do carrinho está errado quando tem cupom. Corrige?' },
  {
    kind: 'thought',
    text: 'Vou procurar onde o desconto é aplicado e ver a ordem das operações.',
  },
  {
    kind: 'tool',
    id: 't1',
    title: 'Ler src/carrinho/total.ts',
    status: 'completed',
    toolKind: 'read',
  },
  {
    kind: 'tool',
    id: 't2',
    title: 'Buscar "aplicarCupom"',
    status: 'completed',
    toolKind: 'search',
  },
  {
    kind: 'agent',
    text: [
      '## O que encontrei',
      '',
      'O cupom é aplicado **antes** do frete, mas a regra diz que vale só sobre os itens:',
      '',
      '1. `subtotal` soma os itens;',
      '2. o desconto entra sobre o `subtotal`;',
      '3. o frete é somado *depois*.',
      '',
      '```ts',
      'export function total(itens: Item[], cupom?: Cupom): number {',
      '  const subtotal = itens.reduce((s, i) => s + i.preco * i.qtd, 0);',
      '  // O desconto não incide sobre o frete.',
      '  return aplicarCupom(subtotal, cupom) + frete(itens);',
      '}',
      '```',
      '',
      '> Detalhes na [issue #42](https://github.com/exemplo/loja/issues/42).',
    ].join('\n'),
  },
  {
    kind: 'tool',
    id: 't3',
    title: 'Editar src/carrinho/total.ts',
    status: 'completed',
    toolKind: 'edit',
  },
  {
    kind: 'permission',
    id: 'px',
    title: 'Executar `pnpm test carrinho`',
    answer: 'permitido',
  },
  {
    kind: 'tool',
    id: 't4',
    title: 'pnpm test carrinho',
    status: 'in_progress',
    toolKind: 'execute',
  },
];

const tasks: Task[] = [
  {
    id: 't1',
    titulo: 'Checkout em uma página',
    descricao: 'Juntar endereço, frete e pagamento numa página só, **sem** perder o rascunho.',
    repoPath: 'C:/dev/loja',
    status: 'executando',
    criadaEm: iso(14),
    runs: ['r1'],
    entrega: 'pr',
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
    agentes: [
      { sessionId: 's4', profileId: 'claude', papel: 'maestro', profundidade: 0 },
      { sessionId: 's1', profileId: 'claude', papel: 'executor', profundidade: 1 },
    ],
    rodadas: [
      {
        numero: 1,
        inicio: iso(8),
        veredito: 'falhou',
        verificacoes: [
          { nome: 'pnpm test', ok: false, saida: '', duracaoMs: 12_000 },
          { nome: 'pnpm lint', ok: true, saida: '', duracaoMs: 4_000 },
        ],
      },
    ],
    decisoes: [],
  },
  {
    id: 'r2',
    taskId: 't2',
    status: 'concluída',
    inicio: iso(600),
    fim: iso(560),
    branch: 'fakl/t2',
    agentes: [],
    rodadas: [],
    decisoes: [],
    resumo: 'Dependências atualizadas; nenhum teste quebrou.',
    prUrl: 'https://github.com/exemplo/site/pull/7',
  },
];

const decisions: Decision[] = [
  {
    id: 'd1',
    runId: 'r1',
    pergunta: 'Os testes falharam na rodada 1. Tentar de novo com o revisor?',
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
    anthropic: { tokensEntrada: 410_000, tokensSaida: 52_000, custoUsd: 14.3 },
    openai: { tokensEntrada: 1_780_000, tokensSaida: 120_000, custoUsd: 0 },
    google: { tokensEntrada: 120_000, tokensSaida: 18_000, custoUsd: 0 },
  },
  porSessao: {},
  tetos: { anthropic: { custoUsd: 20 }, openai: { tokens: 2_000_000 } },
  bloqueados: [],
};

const claudeDir = (slot: number): string => `C:/Users/dev/.fakl/accounts/claude/${String(slot)}`;
const noUse = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };

/** A conta 1 está perto do limite; a 2 está livre; a 3 nunca fez login. */
let claude: ClaudeAccountsState = {
  ativa: 1,
  contas: [
    {
      slot: 1,
      apelido: 'Pessoal',
      dir: claudeDir(1),
      logada: true,
      email: 'dev@exemplo.com',
      plano: 'Max',
      ativa: true,
      uso: { tokensEntrada: 1_840_000, tokensSaida: 152_000, custoUsd: 0 },
    },
    {
      slot: 2,
      apelido: 'Trabalho',
      dir: claudeDir(2),
      logada: true,
      email: 'dev@empresa.com',
      plano: 'Pro',
      ativa: false,
      uso: noUse,
    },
    { slot: 3, apelido: 'Conta 3', dir: claudeDir(3), logada: false, ativa: false, uso: noUse },
  ],
};

function setClaudeActive(slot: ClaudeAccountSlot | null): ClaudeAccountsState {
  claude = {
    ...(slot ? { ativa: slot } : {}),
    contas: claude.contas.map((conta) => ({ ...conta, ativa: conta.slot === slot })),
  };
  const ref = claude.contas.find((conta) => conta.slot === slot);
  for (const [index, agent] of agents.entries()) {
    if (agent.profileId !== 'claude' || isFinalAgentState(agent.state)) continue;
    agents[index] = ref
      ? { ...agent, contaClaude: { slot: ref.slot, apelido: ref.apelido } }
      : (Object.fromEntries(
          Object.entries(agent).filter(([key]) => key !== 'contaClaude'),
        ) as unknown as AgentSessionInfo);
  }
  return claude;
}

const profiles: AgentProfileEntry[] = [
  ['claude', 'Claude Code', 'anthropic'],
  ['codex', 'Codex', 'openai'],
  ['gemini', 'Gemini CLI', 'google'],
].map(([id, nome, provedor]) => ({
  arquivo: `${String(id)}.yaml`,
  profile: {
    id: String(id),
    nome: String(nome),
    provedor: String(provedor),
    adaptador: 'acp',
    podeSerMaestro: id === 'claude',
  },
}));

let eventId = 0;
const nextId = (): string => `01ZZZZZZZZZZZZZZZZ${String(++eventId).padStart(8, '0')}`;

export class RemoteSession {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  closed = false;

  static connect(_target: DeviceTarget, _keys: KeyPair): Promise<RemoteSession> {
    if (location.search.includes('offline'))
      return Promise.reject(new RemoteError('offline', 'A IDE não está aberta.'));
    const session = new RemoteSession();
    session.stream();
    return Promise.resolve(session);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>;
    const answer = (value: unknown): Promise<T> =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(value as T);
        }, 40),
      );
    switch (method) {
      case 'agents.list':
        return answer(agents);
      case 'agents.permissions':
        return answer(permissions);
      case 'agents.transcript': {
        const result: AgentTranscriptResult =
          p.sessionId === 's1'
            ? { items: transcript, omitidos: 0, ultimoEvento: '00' }
            : { items: [{ kind: 'agent', text: 'Oi! Em que posso ajudar?' }], omitidos: 0 };
        return answer(result);
      }
      case 'tasks.list':
        return answer(tasks);
      case 'tasks.get':
        return answer({ runs: runs.filter((r) => r.taskId === p.taskId) });
      case 'runs.decisions':
        return answer(decisions);
      case 'costs.summary':
        return answer(summary);
      case 'profiles.list':
        return answer(profiles);
      case 'claude.accounts.list':
        return answer(claude);
      case 'claude.accounts.setActive':
        return answer(setClaudeActive((p.slot ?? null) as ClaudeAccountSlot | null));
      case 'cafe.open':
      case 'cafe.state':
        return Promise.reject(new Error('sem café na prévia'));
      default:
        return answer(null);
    }
  }

  /** O agente s1 vai escrevendo a resposta, aos pedaços. */
  private stream(): void {
    const chunks = [
      'Os testes do carrinho ',
      'passaram: **12 de 12**. ',
      '\n\nResumo da correção:\n\n- o cupom vale só sobre os itens;\n- ',
      'o frete entra depois do desconto.',
    ];
    const emit = (event: Omit<FaklEvent, 'id' | 'ts'>): void => {
      for (const listener of this.listeners) {
        listener('events.event', {
          subscriptionId: 'x',
          event: { ...event, id: nextId(), ts: new Date().toISOString() },
        });
      }
    };
    setTimeout(() => {
      emit({
        topic: 'agent.tool',
        subject: 's1',
        data: { toolCallId: 't4', status: 'completed' },
      });
    }, 900);
    chunks.forEach((text, index) => {
      setTimeout(
        () => {
          emit({ topic: 'agent.output', subject: 's1', data: { kind: 'message', text } });
        },
        1_200 + index * 500,
      );
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(_listener: (error: RemoteError) => void): () => void {
    return () => undefined;
  }

  close(): void {
    this.closed = true;
  }
}
