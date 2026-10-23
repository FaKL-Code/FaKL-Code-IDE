import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  agentStateLabel,
  baseName,
  changeStatusLabel,
  composeMessage,
  dirName,
  fileKind,
  filterEntries,
  formatCost,
  formatTokens,
  fuzzyScore,
  groupEntries,
  moveIndex,
  permissionLine,
  preview,
  providerColor,
  relativeTime,
  sumUsage,
  toolIconName,
  toolRunning,
  toolStatusLabel,
  usageBreakdown,
} from '../src/webview/chat-model.js';
import { expandMentions, mentionAt } from '../src/webview/mesa-model.js';

describe('arquivos', () => {
  it('classifica pelo nome e extensão', () => {
    expect(fileKind('src/a.ts')).toBe('code');
    expect(fileKind('package.json')).toBe('data');
    expect(fileKind('pnpm-lock.yaml')).toBe('lock');
    expect(fileKind('README.MD')).toBe('doc');
    expect(fileKind('Dockerfile')).toBe('config');
    expect(fileKind('src/')).toBe('folder');
    expect(fileKind('semextensao')).toBe('file');
  });

  it('separa nome e pasta nos dois separadores', () => {
    expect(baseName('a/b/c.ts')).toBe('c.ts');
    expect(baseName('a\\b\\c.ts')).toBe('c.ts');
    expect(dirName('a/b/c.ts')).toBe('a/b');
    expect(dirName('c.ts')).toBe('');
  });
});

describe('filtro dos menus', () => {
  const entries = [
    { id: '1', label: 'Claude Opus', description: 'o mais capaz' },
    { id: '2', label: 'Claude Sonnet', description: 'equilibrado' },
    { id: '3', label: 'Haiku', description: 'rápido e barato', keywords: 'claude small' },
  ];

  it('sem busca, devolve tudo na ordem', () => {
    expect(filterEntries(entries, '  ').map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  it('prefixo vem antes de trecho e fuzzy', () => {
    expect(fuzzyScore('cl', 'Claude')).toBe(0);
    expect(fuzzyScore('au', 'Claude')).toBeGreaterThan(1);
    expect(fuzzyScore('cde', 'Claude')).toBeGreaterThanOrEqual(10);
    expect(fuzzyScore('xyz', 'Claude')).toBeUndefined();
  });

  it('acha pelo rótulo, palavras-chave e descrição', () => {
    expect(filterEntries(entries, 'sonnet').map((e) => e.id)).toEqual(['2']);
    expect(filterEntries(entries, 'small').map((e) => e.id)).toEqual(['3']);
    expect(filterEntries(entries, 'barato').map((e) => e.id)).toEqual(['3']);
    expect(filterEntries(entries, 'zzz')).toEqual([]);
  });

  it('o rótulo ganha da palavra-chave na ordem', () => {
    const result = filterEntries(entries, 'claude').map((e) => e.id);
    expect(result).toEqual(['1', '2', '3']);
  });

  it('prefere começo de palavra em caminhos', () => {
    const files = [
      { id: 'a', label: 'xchat.ts', keywords: 'src/xchat.ts' },
      { id: 'b', label: 'chat.ts', keywords: 'src/chat.ts' },
    ];
    expect(filterEntries(files, 'chat').map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('agrupa na ordem da primeira aparição', () => {
    const grouped = groupEntries([
      { id: '1', label: 'a', group: 'X' },
      { id: '2', label: 'b', group: 'Y' },
      { id: '3', label: 'c', group: 'X' },
    ]);
    expect(grouped.map((g) => [g.group, g.entries.map((e) => e.id)])).toEqual([
      ['X', ['1', '3']],
      ['Y', ['2']],
    ]);
  });

  it('navega com volta nas pontas', () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});

describe('menções', () => {
  it('detecta @ e # antes do cursor', () => {
    expect(mentionAt('oi @cla', 7)).toEqual({ kind: '@', query: 'cla', start: 3 });
    expect(mentionAt('veja #src/a', 11)).toEqual({ kind: '#', query: 'src/a', start: 5 });
    expect(mentionAt('a@b', 3)).toBeUndefined();
  });

  it('junta os chips antes do texto, sem repetir', () => {
    const chips = [
      { kind: 'file', label: 'a.ts', insert: '#src/a.ts' },
      { kind: 'agent', label: 'Rev', insert: '@Rev' },
      { kind: 'file', label: 'a.ts', insert: '#src/a.ts' },
    ] as const;
    expect(composeMessage(chips, '  corrija ')).toBe('#src/a.ts @Rev corrija');
    expect(composeMessage(chips, '')).toBe('#src/a.ts @Rev');
    expect(composeMessage([], ' oi ')).toBe('oi');
  });

  it('anexa a última resposta do agente citado', () => {
    const text = expandMentions('@Rev leia', new Map([['Rev', 'ok']]));
    expect(text).toContain('Last reply from Rev:\nok');
  });
});

describe('uso', () => {
  const usage = { inputTokens: 750, outputTokens: 250, totalTokens: 1000 };

  it('formata tokens e custo', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(2_000_000)).toBe('2M');
    expect(formatCost({ amount: 0.0123, currency: 'USD' })).toBe('$0.0123');
    expect(formatCost({ amount: 3.5, currency: 'EUR' })).toBe('EUR 3.50');
    expect(formatCost(undefined)).toBe('');
  });

  it('calcula a parte de entrada e saída', () => {
    expect(usageBreakdown(usage)).toMatchObject({
      inputShare: 0.75,
      outputShare: 0.25,
      total: 1000,
    });
    expect(usageBreakdown({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }).inputShare).toBe(0);
    expect(usageBreakdown({ ...usage, cacheReadTokens: 600 }).cached).toBe(600);
    expect(usageBreakdown(usage).cached).toBe(0);
  });

  it('soma as conversas e descarta custo de moedas misturadas', () => {
    const a = { usage: { ...usage, cost: { amount: 1, currency: 'USD' } } };
    const b = {
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
        cost: { amount: 2, currency: 'USD' },
      },
    };
    expect(sumUsage([a, b])).toEqual({
      inputTokens: 760,
      outputTokens: 250,
      totalTokens: 1010,
      cost: { amount: 3, currency: 'USD' },
    });
    const c = { usage: { ...usage, cost: { amount: 1, currency: 'BRL' } } };
    expect(sumUsage([a, c]).cost).toBeUndefined();
  });
});

describe('apresentação', () => {
  it('mostra o tempo relativo', () => {
    useLocale('pt-BR');
    try {
      const now = 1_000_000_000_000;
      expect(relativeTime(now - 10_000, now)).toBe('agora');
      expect(relativeTime(now - 5 * 60_000, now)).toBe('há 5 min');
      expect(relativeTime(now - 3 * 3_600_000, now)).toBe('há 3 h');
    } finally {
      useLocale('en');
    }
  });

  it('escolhe ícone e estado da ferramenta', () => {
    expect(toolIconName('execute')).toBe('terminal');
    expect(toolIconName('edit')).toBe('pencil');
    expect(toolIconName(undefined)).toBe('wrench');
    expect(toolRunning(undefined)).toBe(true);
    expect(toolRunning('in_progress')).toBe(true);
    expect(toolRunning('completed')).toBe(false);
    expect(toolRunning('failed')).toBe(false);
  });

  it('dá nome ao estado da ferramenta, da conversa e do arquivo', () => {
    expect(toolStatusLabel(undefined)).toBe('Queued');
    expect(toolStatusLabel('pending')).toBe('Queued');
    expect(toolStatusLabel('in_progress')).toBe('Running');
    expect(toolStatusLabel('completed')).toBe('Complete');
    expect(toolStatusLabel('failed')).toBe('Failed');
    expect(toolStatusLabel('desconhecido')).toBe('Queued');
    expect(agentStateLabel('aguardando-permissão')).toBe('waiting for permission');
    expect(agentStateLabel('concluído')).toBe('finished');
    expect(changeStatusLabel('adicionado')).toBe('added');
  });

  it('usa só variáveis do tema nas cores do provedor', () => {
    for (const p of ['anthropic', 'openai', 'google', 'ollama', 'outro', undefined]) {
      expect(providerColor(p)).toMatch(/^var\(--vscode-/);
    }
  });

  it('corta a prévia na primeira linha', () => {
    expect(preview('linha um\nlinha dois')).toBe('linha um');
    expect(preview('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

describe('permissionLine', () => {
  it('junta os argumentos da chamada ao título', () => {
    expect(
      permissionLine('mcp__fakl__ssh_exec', 'host: 203.0.113.10\ncomando: uptime; df -h'),
    ).toBe('mcp__fakl__ssh_exec (host: 203.0.113.10 · comando: uptime; df -h)');
    expect(permissionLine('Editar a.txt')).toBe('Editar a.txt');
    expect(permissionLine('Editar a.txt', '  \n')).toBe('Editar a.txt');
  });

  it('corta linhas longas', () => {
    const line = permissionLine('ssh_exec', `comando: ${'x'.repeat(500)}`, 40);
    expect(line).toHaveLength(40);
    expect(line.endsWith('…)')).toBe(true);
  });
});

describe('em pt-BR', () => {
  afterEach(() => {
    useLocale('en');
  });

  it('mostra os estados como antes da tradução', () => {
    useLocale('pt-br');
    expect(formatCost({ amount: 0.0123, currency: 'USD' })).toBe('US$ 0.0123');
    expect(toolStatusLabel(undefined)).toBe('Na fila');
    expect(toolStatusLabel('in_progress')).toBe('Executando');
    expect(toolStatusLabel('completed')).toBe('Concluída');
    expect(toolStatusLabel('failed')).toBe('Falhou');
    expect(agentStateLabel('aguardando-permissão')).toBe('aguardando-permissão');
    expect(agentStateLabel('concluído')).toBe('concluído');
    expect(changeStatusLabel('removido')).toBe('removido');
  });
});
