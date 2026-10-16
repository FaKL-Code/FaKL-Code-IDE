import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { l10n } from '@fakl/i18n';
import type {
  AgentPermissionRequest,
  AgentSessionInfo,
  ClaudeAccountsState,
  CoreMethod,
  CostSummary,
  Decision,
  Run,
  SshExecResult,
  SshHostInfo,
  Task,
} from '@fakl/protocol';

/** O que a CLI precisa do Core; nos testes, um objeto falso. */
export interface CoreApi {
  request<T = unknown>(method: CoreMethod, params?: unknown): Promise<T>;
}

export interface Io {
  out(line: string): void;
  cwd: string;
  /** Espera entre consultas de `--aguardar`; nos testes, instantânea. */
  sleep?: (ms: number) => Promise<void>;
  /** Entrada padrão inteira; o credential helper do git lê o pedido por ela. */
  stdin?: () => Promise<string>;
}

/** Uma linha da ajuda: o comando alinhado em 38 colunas e o que ele faz. */
function line(syntax: string, description = ''): string {
  const left = `  ${syntax}`;
  if (!description) return left;
  return left.length < 38 ? `${left.padEnd(38)}${description}` : `${left} ${description}`;
}

/** A ajuda da CLI, no idioma escolhido em `useLocale`. */
export function usage(): string {
  const indent = ' '.repeat(38);
  return [
    l10n.t('fakl: controls FaKL Core from the command line.'),
    '',
    l10n.t('Usage:'),
    line('fakl status', l10n.t('Core status')),
    line('fakl agentes', l10n.t('agent sessions')),
    line(l10n.t('fakl tarefa criar <title> [options]'), l10n.t('creates a task (origin: cli)')),
    `      --descricao ${l10n.t('<text>')}  --repo ${l10n.t('<folder>')}  --maestro ${l10n.t('<profile>')}`,
    '      --criterio "cmd1; cmd2"  --entrega pr-merge|merge|pr|branch  --comecar',
    '      --permissoes perguntar|aprovar-leitura|aprovar-tudo|autopilot',
    line(
      l10n.t('fakl maestro "<task>" [options]'),
      l10n.t('creates the task from the text and starts the maestro right away'),
    ),
    `      --repo ${l10n.t('<folder>')}  --maestro ${l10n.t('<profile>')}  --criterio "cmd1; cmd2"`,
    `      --entrega pr-merge|merge|pr|branch  --rodadas <n>  --tempo ${l10n.t('<minutes>')}`,
    `      --permissoes ...  ${l10n.t('(default perguntar; use aprovar-tudo for a run with nobody watching)')}`,
    `      --aguardar  ${l10n.t('follows the run to the end and shows the result')}`,
    line('fakl tarefas', l10n.t('lists the tasks')),
    line(l10n.t('fakl executar <task>'), l10n.t('starts a run')),
    line(l10n.t('fakl execucao <run>'), l10n.t('shows a run')),
    line(l10n.t('fakl parar <run>'), l10n.t('stops a run')),
    line('fakl decisoes', l10n.t('pending decisions and permission requests')),
    line(l10n.t('fakl decidir <run> <decision> <option>')),
    line(
      l10n.t('fakl permitir <session> <request>'),
      l10n.t("approves an agent's permission request"),
    ),
    line(l10n.t('fakl negar <session> <request>'), l10n.t('denies a permission request')),
    line(l10n.t('fakl opcoes <session>'), l10n.t('model, reasoning and other options of an agent')),
    line(
      l10n.t('fakl opcao <session> <option> <value>'),
      l10n.t('changes an option, like: fakl opcao <session> model forte'),
    ),
    line(l10n.t('fakl modo <session> <mode>'), l10n.t("changes an agent's permission mode")),
    `${indent}(perguntar, aprovar-leitura, aprovar-tudo, autopilot)`,
    line(l10n.t('fakl custos [YYYY-MM-DD]'), l10n.t("the day's spending per provider")),
    line(
      'fakl contas',
      l10n.t('Claude accounts (up to 3), the active one and how much each spent'),
    ),
    line(
      'fakl conta usar <1|2|3|nenhuma>',
      l10n.t('switches the Claude account; open agents switch too'),
    ),
    `${indent}${l10n.t('(busy ones at the end of their turn), without losing the conversation')}`,
    line(l10n.t('fakl conta renomear <1|2|3> <nickname>')),
    line(l10n.t('fakl ssh [host command...]'), l10n.t('SSH hosts, or runs a command on a host')),
    line('fakl auditoria [--verificar]', l10n.t('latest audited actions; checks the chain')),
    line('fakl git-credential get', l10n.t("git credential helper with the IDE's login")),
    l10n.t('--json on any command prints the raw response.'),
  ].join('\n');
}

function money(value: number): string {
  return l10n.t('${0}', value.toFixed(2));
}

function runLine(run: Run): string {
  return [
    run.id,
    run.status,
    l10n.t('{0} round(s)', run.rodadas.length),
    l10n.t('{0} agent(s)', run.agentes.length),
    run.resultado ?? '',
    run.prUrl ?? '',
    run.motivo ?? '',
  ]
    .filter(Boolean)
    .join('  ');
}

/** Roda um comando; devolve o código de saída. */
export async function runCli(
  argv: readonly string[],
  core: () => Promise<CoreApi>,
  io: Io,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      descricao: { type: 'string' },
      repo: { type: 'string' },
      maestro: { type: 'string' },
      criterio: { type: 'string' },
      entrega: { type: 'string' },
      permissoes: { type: 'string' },
      comecar: { type: 'boolean' },
      aguardar: { type: 'boolean' },
      rodadas: { type: 'string' },
      tempo: { type: 'string' },
      verificar: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    io.out(usage());
    return command || values.help ? 0 : 1;
  }
  const print = (data: unknown, text: () => string): void => {
    io.out(values.json ? JSON.stringify(data, null, 2) : text());
  };
  if (command === 'git-credential') return gitCredential(rest[0], core, io);
  const api = await core();

  switch (command) {
    case 'status': {
      const sessions = await api.request<AgentSessionInfo[]>('agents.list');
      const pending = await api.request<Decision[]>('runs.decisions');
      const permissions = await api.request<AgentPermissionRequest[]>('agents.permissions');
      print(
        { sessions: sessions.length, decisoes: pending.length, permissoes: permissions.length },
        () =>
          l10n.t(
            'Core is up. {0} agent session(s), {1} decision(s) and {2} permission request(s) pending.',
            sessions.length,
            pending.length,
            permissions.length,
          ),
      );
      return 0;
    }
    case 'agentes': {
      const sessions = await api.request<AgentSessionInfo[]>('agents.list');
      print(sessions, () =>
        sessions.length === 0
          ? l10n.t('No agents.')
          : sessions
              .map(
                (s) =>
                  `${s.sessionId}  ${s.nome}  ${s.state}  ${s.permissoes}  ${s.worktree?.branch ?? s.cwd}`,
              )
              .join('\n'),
      );
      return 0;
    }
    case 'tarefa': {
      if (rest[0] !== 'criar' || !rest[1]) {
        io.out(l10n.t('Usage: fakl tarefa criar <title> [options]'));
        return 1;
      }
      const comandos = (values.criterio ?? '')
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean);
      const task = await api.request<Task>('tasks.create', {
        titulo: rest.slice(1).join(' '),
        origem: 'cli',
        repoPath: resolve(io.cwd, values.repo ?? '.'),
        ...(values.descricao ? { descricao: values.descricao } : {}),
        ...(values.maestro ? { maestroProfileId: values.maestro } : {}),
        ...(values.entrega ? { entrega: values.entrega } : {}),
        ...(values.permissoes ? { permissoes: values.permissoes } : {}),
        ...(comandos.length > 0 ? { criterio: { comandos } } : {}),
      });
      let run: Run | undefined;
      if (values.comecar) run = await api.request<Run>('runs.start', { taskId: task.id });
      print({ task, run }, () =>
        [
          l10n.t('Task {0} created: {1}', task.id, task.titulo),
          run ? l10n.t('Run {0} started.', run.id) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return 0;
    }
    case 'maestro': {
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        io.out(l10n.t('Usage: fakl maestro "<task>" [options]'));
        return 1;
      }
      return maestro(prompt, values, api, io, print);
    }
    case 'tarefas': {
      const tasks = await api.request<Task[]>('tasks.list');
      print(tasks, () =>
        tasks.length === 0
          ? l10n.t('No tasks.')
          : tasks.map((t) => `${t.id}  ${t.status}  ${t.titulo}`).join('\n'),
      );
      return 0;
    }
    case 'executar': {
      if (!rest[0]) {
        io.out(l10n.t('Usage: fakl executar <task>'));
        return 1;
      }
      const run = await api.request<Run>('runs.start', { taskId: rest[0] });
      print(run, () => l10n.t('Run {0} started.', run.id));
      return 0;
    }
    case 'execucao': {
      if (!rest[0]) {
        io.out(l10n.t('Usage: fakl execucao <run>'));
        return 1;
      }
      const run = await api.request<Run>('runs.get', { runId: rest[0] });
      print(run, () =>
        [
          runLine(run),
          ...run.rodadas.map(
            (r) =>
              `  ${l10n.t('round {0}: {1}', r.numero, r.veredito ?? '?')}${r.verificacoes.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.nome}`).join('')}`,
          ),
          ...run.agentes.map(
            (a) => `  ${'  '.repeat(a.profundidade)}${a.profileId} (${a.papel}) ${a.branch ?? ''}`,
          ),
        ].join('\n'),
      );
      return 0;
    }
    case 'parar': {
      if (!rest[0]) {
        io.out(l10n.t('Usage: fakl parar <run>'));
        return 1;
      }
      await api.request('runs.stop', { runId: rest[0] });
      print({ ok: true }, () => l10n.t('Run stopped.'));
      return 0;
    }
    case 'decisoes': {
      const pending = await api.request<Decision[]>('runs.decisions');
      const permissions = await api.request<AgentPermissionRequest[]>('agents.permissions');
      print({ decisoes: pending, permissoes: permissions }, () =>
        pending.length + permissions.length === 0
          ? l10n.t('No pending decisions.')
          : [
              ...pending.map(
                (d) =>
                  `${d.runId} ${d.id}\n  ${d.pergunta}\n${d.opcoes.map((o) => `    ${o.id}: ${o.rotulo}`).join('\n')}`,
              ),
              ...permissions.map(
                (p) =>
                  `${p.sessionId} ${p.id}\n  ${l10n.t('Permission: {0}', p.title)}\n    fakl permitir ${p.sessionId} ${p.id}\n    fakl negar ${p.sessionId} ${p.id}`,
              ),
            ].join('\n'),
      );
      return 0;
    }
    case 'permitir':
    case 'negar': {
      const [sessionId, id] = rest;
      if (!sessionId || !id) {
        io.out(
          command === 'permitir'
            ? l10n.t('Usage: fakl permitir <session> <request>')
            : l10n.t('Usage: fakl negar <session> <request>'),
        );
        return 1;
      }
      const allow = command === 'permitir';
      await api.request('agents.permission', { sessionId, id, allow });
      print({ ok: true }, () =>
        allow ? l10n.t('Permission granted.') : l10n.t('Permission denied.'),
      );
      return 0;
    }
    case 'opcoes': {
      const [sessionId] = rest;
      const sessions = await api.request<AgentSessionInfo[]>('agents.list');
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) {
        io.out(l10n.t('Usage: fakl opcoes <session> (see the sessions with fakl agentes)'));
        return 1;
      }
      print(session.opcoes, () =>
        session.opcoes.length === 0
          ? l10n.t('This agent offers no options.')
          : session.opcoes
              .map(
                (o) =>
                  `${o.id}  ${o.nome}: ${String(o.atual)}${o.valores ? `  (${o.valores.map((v) => v.id).join(', ')})` : ''}`,
              )
              .join('\n'),
      );
      return 0;
    }
    case 'opcao': {
      const [sessionId, id, raw] = rest;
      if (!sessionId || !id || raw === undefined) {
        io.out(l10n.t('Usage: fakl opcao <session> <option> <value>'));
        return 1;
      }
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      await api.request('agents.setOption', { sessionId, id, value });
      print({ ok: true }, () => `${id} = ${raw}.`);
      return 0;
    }
    case 'modo': {
      const [sessionId, permissions] = rest;
      if (!sessionId || !permissions) {
        io.out(
          l10n.t('Usage: fakl modo <session> <perguntar|aprovar-leitura|aprovar-tudo|autopilot>'),
        );
        return 1;
      }
      await api.request('agents.setPermissions', { sessionId, permissions });
      print({ ok: true }, () => l10n.t('Agent in {0}.', permissions));
      return 0;
    }
    case 'decidir': {
      const [runId, decisionId, escolha] = rest;
      if (!runId || !decisionId || !escolha) {
        io.out(l10n.t('Usage: fakl decidir <run> <decision> <option>'));
        return 1;
      }
      await api.request('runs.decide', { runId, decisionId, escolha, origem: 'cli' });
      print({ ok: true }, () => l10n.t('Decision recorded.'));
      return 0;
    }
    case 'custos': {
      const summary = await api.request<CostSummary>(
        'costs.summary',
        rest[0] ? { dia: rest[0] } : {},
      );
      print(summary, () =>
        [
          `${summary.dia}: ${money(summary.total.custoUsd)}, ${String(summary.total.tokensEntrada + summary.total.tokensSaida)} tokens`,
          ...Object.entries(summary.porProvedor).map(
            ([provedor, t]) =>
              `  ${provedor}: ${money(t.custoUsd)}, ${String(t.tokensEntrada + t.tokensSaida)} tokens${summary.bloqueados.includes(provedor) ? ` ${l10n.t('(cap reached)')}` : ''}`,
          ),
        ].join('\n'),
      );
      return 0;
    }
    case 'contas': {
      const state = await api.request<ClaudeAccountsState>('claude.accounts.list');
      print(state, () =>
        state.contas
          .map((c) => {
            const quem = c.logada
              ? (c.email ?? l10n.t('signed in'))
              : c.logada === false
                ? l10n.t('signed out')
                : '?';
            const plano = c.plano ? ` (${c.plano})` : '';
            return `${c.ativa ? '*' : ' '} ${String(c.slot)}  ${c.apelido}  ${quem}${plano}  ${money(c.uso.custoUsd)}`;
          })
          .join('\n'),
      );
      return 0;
    }
    case 'conta': {
      const [action, slotText, ...name] = rest;
      const slot = slotText === 'nenhuma' ? null : Number(slotText);
      if (action === 'usar' && (slot === null || [1, 2, 3].includes(slot))) {
        await api.request('claude.accounts.setActive', { slot });
        print({ ok: true }, () =>
          slot === null
            ? l10n.t('Default Claude account; open agents switch too.')
            : l10n.t('Account {0} active; open agents switch too.', slot),
        );
        return 0;
      }
      if (action === 'renomear' && slot !== null && [1, 2, 3].includes(slot) && name.length > 0) {
        await api.request('claude.accounts.rename', { slot, apelido: name.join(' ') });
        print({ ok: true }, () => l10n.t('Nickname saved.'));
        return 0;
      }
      io.out(
        l10n.t('Usage: fakl conta usar <1|2|3|nenhuma> | fakl conta renomear <1|2|3> <nickname>'),
      );
      return 1;
    }
    case 'ssh': {
      if (!rest[0]) {
        const hosts = await api.request<SshHostInfo[]>('ssh.hosts.list');
        print(hosts, () =>
          hosts.length === 0
            ? l10n.t('No hosts. Add them to ~/.ssh/config or through the IDE.')
            : hosts
                .map(
                  (h) =>
                    `${h.alias}  ${h.hostname ?? ''}  ${h.politica}  ${h.origem}${h.tags.length > 0 ? `  #${h.tags.join(' #')}` : ''}`,
                )
                .join('\n'),
        );
        return 0;
      }
      if (!rest[1]) {
        io.out(l10n.t('Usage: fakl ssh <host> <command>'));
        return 1;
      }
      const result = await api.request<SshExecResult>('ssh.exec', {
        host: rest[0],
        comando: rest.slice(1).join(' '),
      });
      print(result, () =>
        [result.saida.trimEnd(), result.erro.trimEnd()].filter(Boolean).join('\n'),
      );
      return result.codigo === 0 ? 0 : 1;
    }
    case 'auditoria': {
      if (values.verificar) {
        const check = await api.request<{ ok: boolean; entradas: number; quebraEm?: string }>(
          'audit.verify',
        );
        print(check, () =>
          check.ok
            ? l10n.t('Chain intact: {0} entry(ies).', check.entradas)
            : l10n.t('Chain broken at entry {0}: the file was changed.', check.quebraEm ?? '?'),
        );
        return check.ok ? 0 : 1;
      }
      const entries = await api.request<
        { ts: string; ator: string; acao: string; alvo?: string; resultado: string }[]
      >('audit.list', { limite: 50 });
      print(entries, () =>
        entries.length === 0
          ? l10n.t('Nothing audited yet.')
          : entries
              .map((e) => `${e.ts}  ${e.resultado}  ${e.acao}  ${e.alvo ?? ''}  (${e.ator})`)
              .join('\n'),
      );
      return 0;
    }
    default:
      io.out(`${l10n.t('Unknown command: {0}', command)}\n\n${usage()}`);
      return 1;
  }
}

type Print = (data: unknown, text: () => string) => void;

const FINAL_RUN = new Set(['concluída', 'falhou', 'descartada']);

/** Número positivo de uma opção da linha de comando, ou erro com o nome dela. */
function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(l10n.t('--{0} must be a number greater than zero', name));
  }
  return n;
}

/**
 * `fakl maestro "<tarefa>"`: o texto vira uma tarefa (título = primeira linha) e o
 * maestro começa na hora, no repositório da pasta atual. Sem `--permissoes`, vale
 * perguntar; para execução sem ninguém olhando, passe `--permissoes aprovar-tudo`.
 */
async function maestro(
  prompt: string,
  values: {
    repo?: string | undefined;
    maestro?: string | undefined;
    criterio?: string | undefined;
    entrega?: string | undefined;
    permissoes?: string | undefined;
    rodadas?: string | undefined;
    tempo?: string | undefined;
    aguardar?: boolean | undefined;
    json?: boolean | undefined;
  },
  api: CoreApi,
  io: Io,
  print: Print,
): Promise<number> {
  const firstLine = prompt.split(/\r?\n/)[0] ?? prompt;
  const titulo = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const comandos = (values.criterio ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean);
  const rodadas = positive(values.rodadas, 'rodadas');
  const tempo = positive(values.tempo, 'tempo');
  const task = await api.request<Task>('tasks.create', {
    titulo,
    descricao: prompt,
    origem: 'cli',
    repoPath: resolve(io.cwd, values.repo ?? '.'),
    permissoes: values.permissoes ?? 'perguntar',
    ...(values.maestro ? { maestroProfileId: values.maestro } : {}),
    ...(values.entrega ? { entrega: values.entrega } : {}),
    ...(comandos.length > 0 ? { criterio: { comandos } } : {}),
    ...(rodadas || tempo
      ? {
          limites: {
            ...(rodadas ? { rodadas: { valor: rodadas } } : {}),
            ...(tempo ? { tempoMin: { valor: tempo } } : {}),
          },
        }
      : {}),
  });
  const run = await api.request<Run>('runs.start', { taskId: task.id });
  if (!values.aguardar) {
    print({ task, run }, () =>
      [
        l10n.t('Task {0}: {1}', task.id, task.titulo),
        l10n.t('Run {0} started (maestro {1}).', run.id, run.agentes[0]?.profileId ?? '?'),
        l10n.t("Follow it: fakl execucao {0}  (or on the IDE's Desk)", run.id),
      ].join('\n'),
    );
    return 0;
  }
  io.out(
    l10n.t(
      'Run {0} started. Following it to the end (Ctrl+C exits without stopping the run).',
      run.id,
    ),
  );
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let last = '';
  const asked = new Set<string>();
  for (;;) {
    const current = await api.request<Run>('runs.get', { runId: run.id });
    const line = runLine(current);
    if (line !== last) {
      last = line;
      if (!values.json) io.out(line);
    }
    const pending = await api.request<Decision[]>('runs.decisions');
    const mine = pending.filter((d) => d.runId === run.id && !asked.has(d.id));
    if (mine[0]) {
      asked.add(mine[0].id);
      io.out(
        l10n.t(
          'Question from the maestro: {0}  (answer with fakl decidir {1} {2} <option>)',
          mine[0].pergunta,
          run.id,
          mine[0].id,
        ),
      );
    }
    if (FINAL_RUN.has(current.status)) {
      print(current, () => runLine(current));
      return current.status === 'concluída' ? 0 : 1;
    }
    await sleep(2_000);
  }
}

/**
 * Credential helper do git (SDD 11.1): `git config credential.helper "!fakl
 * git-credential"`. Para github.com, entrega o login da IDE; para o resto, nada,
 * e o git segue para o próximo helper.
 */
async function gitCredential(
  action: string | undefined,
  core: () => Promise<CoreApi>,
  io: Io,
): Promise<number> {
  if (action !== 'get') return 0;
  const input = (await io.stdin?.()) ?? '';
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  if ((fields.get('protocol') ?? 'https') !== 'https') return 0;
  const host = fields.get('host') ?? 'github.com';
  // Sem o Core (IDE fechada), não responde nada e o git segue para o próximo helper.
  const api = await core().catch(() => undefined);
  const credential = await api
    ?.request<{ username: string; password: string } | null>('github.gitCredential', { host })
    .catch(() => null);
  if (credential) io.out(`username=${credential.username}\npassword=${credential.password}`);
  return 0;
}
