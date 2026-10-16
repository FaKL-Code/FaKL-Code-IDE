import { useLocale } from '@fakl/i18n';
import type { AgentSessionInfo, AgentState } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attentionQueue,
  CARD_H,
  CARD_W,
  EMPTY_LAYOUT,
  expandMentions,
  fitView,
  floorsOf,
  initials,
  mentionAt,
  parseLayout,
  placeNew,
  portalUrl,
  roleColor,
  ropePath,
  snap,
  tidy,
  usageRing,
} from '../src/webview/mesa-model.js';

function session(sessionId: string, state: AgentState, branch?: string): AgentSessionInfo {
  return {
    sessionId,
    profileId: 'claude',
    nome: 'Claude',
    cwd: '/repo',
    state,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    permissoes: 'perguntar',
    opcoes: [],
    ...(branch ? { worktree: { path: `/wt/${sessionId}`, branch } } : {}),
  };
}

describe('Mesa: grade e layout salvo', () => {
  it('encaixa na grade de 20', () => {
    expect(snap(29)).toBe(20);
    expect(snap(31)).toBe(40);
    expect(snap(-11)).toBe(-20);
  });

  it('lê o layout salvo e descarta o que está quebrado', () => {
    expect(parseLayout(undefined)).toEqual(EMPTY_LAYOUT);
    const layout = parseLayout({
      cards: { a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 'x' } },
      notes: [{ id: 'n', text: 'oi', x: 1, y: 2, w: 3, h: 4 }, { id: 2 }],
      links: [{ from: 'a', to: 'n' }, { from: 1 }],
      view: { x: 5, y: 6, zoom: 9 },
    });
    expect(Object.keys(layout.cards)).toEqual(['a']);
    expect(layout.notes).toHaveLength(1);
    expect(layout.links).toEqual([{ from: 'a', to: 'n' }]);
    expect(layout.view).toEqual({ x: 5, y: 6, zoom: 2 });
  });
});

describe('Mesa: arrumação', () => {
  const roles = [
    { sessionId: 'm', papel: 'maestro' },
    { sessionId: 'a', papel: 'executor', parentSessionId: 'm' },
    { sessionId: 'b', papel: 'revisor', parentSessionId: 'm' },
  ];

  it('põe o maestro em cima, centrado sobre os subagentes', () => {
    const out = tidy(['m', 'a', 'b', 'solto'], roles);
    expect(out.a?.y).toBeGreaterThan(out.m?.y ?? 0);
    expect(out.a?.y).toBe(out.b?.y);
    const center = (id: string): number => (out[id]?.x ?? 0) + CARD_W / 2;
    expect(Math.abs(center('m') - (center('a') + center('b')) / 2)).toBeLessThanOrEqual(20);
    expect(out.solto?.x).toBeGreaterThan(out.b?.x ?? 0);
    expect(out.solto?.y).toBe(out.m?.y);
  });

  it('cartão novo cai embaixo do pai, ao lado dos irmãos', () => {
    const cards = { m: { x: 0, y: 0, w: CARD_W, h: CARD_H } };
    const first = placeNew('a', cards, roles);
    expect(first.x).toBe(0);
    expect(first.y).toBeGreaterThan(CARD_H);
    const second = placeNew('b', { ...cards, a: first }, roles);
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x + CARD_W);
    const loose = placeNew('x', { ...cards, a: first }, []);
    expect(loose.x).toBeGreaterThan(first.x + CARD_W);
  });
});

describe('Mesa: andares e atenção', () => {
  it('agrupa por worktree e diz se dá para pousar', () => {
    const floors = floorsOf(
      [
        session('a', 'executando', 'fakl/avulso/a'),
        session('b', 'ocioso', 'fakl/avulso/b'),
        session('c', 'aguardando-permissão', 'fakl/avulso/c'),
        session('d', 'concluído'),
        session('e', 'ocioso', 'fakl/avulso/e'),
      ],
      new Map([['b', 2]]),
    );
    const byName = Object.fromEntries(
      floors.map((f) => [f.key.replace('fakl/avulso/', '').replace('/repo', 'repo'), f]),
    );
    expect(byName.a?.state).toBe('trabalhando');
    expect(byName.b).toMatchObject({ state: 'revisar', arquivos: 2, worktree: true });
    expect(byName.c?.state).toBe('bloqueado');
    expect(byName.repo).toMatchObject({ state: 'concluído', worktree: false });
    expect(byName.e).toMatchObject({ state: 'livre', nome: 'Claude · e' });
  });

  it('pedidos de permissão vêm antes de perguntas e falhas', () => {
    const queue = attentionQueue([
      session('f', 'falhou'),
      session('p', 'aguardando-você'),
      session('o', 'ocioso'),
      session('q', 'aguardando-permissão'),
    ]);
    expect(queue).toEqual(['q', 'p', 'f']);
  });
});

describe('Mesa: desenho', () => {
  it('cabo sai da base de um cartão e entra no topo do outro', () => {
    const d = ropePath({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 300, w: 100, h: 100 });
    expect(d.startsWith('M50,100 C')).toBe(true);
    expect(d.endsWith(' 50,300')).toBe(true);
  });

  it('enquadra uma área no meio do viewport', () => {
    const view = fitView({ x: 0, y: 0, w: 1000, h: 500 }, 1200, 700, 100);
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(100);
    expect(view.y).toBe(100);
  });

  it('iniciais e cores estáveis', () => {
    expect(initials('Claude Code')).toBe('CC');
    expect(initials('Local 7B')).toBe('L');
    expect(initials('codex')).toBe('C');
    expect(roleColor('maestro')).toBe('#fbbf24');
    expect(roleColor('documentador')).toBe(roleColor('documentador'));
  });
});

describe('Mesa: prévias, uso e menções', () => {
  it('só abre prévias http(s)', () => {
    expect(portalUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(portalUrl('https://exemplo.com')).toBe('https://exemplo.com/');
    expect(portalUrl('javascript:alert(1)')).toBeUndefined();
    expect(portalUrl('file:///etc/passwd')).toBeUndefined();
    expect(portalUrl('  ')).toBeUndefined();
    const layout = parseLayout({
      portals: [
        { id: 'p', url: 'http://localhost:3000/', x: 0, y: 0, w: 1, h: 1 },
        { id: 'q', url: 'javascript:x', x: 0, y: 0, w: 1, h: 1 },
      ],
    });
    expect(layout.portals.map((p) => p.id)).toEqual(['p']);
  });

  it('anel de uso pelo teto em dólar, em tokens ou sem teto', () => {
    const totals = { tokensEntrada: 30_000, tokensSaida: 10_000, custoUsd: 2.5 };
    expect(usageRing('anthropic', totals, { custoUsd: 10 }, false)).toMatchObject({
      fracao: 0.25,
      gasto: '$2.50',
      teto: '$10.00',
    });
    expect(usageRing('google', totals, { tokens: 20_000 }, true)).toMatchObject({
      fracao: 1,
      bloqueado: true,
    });
    const free = usageRing('ollama', { ...totals, custoUsd: 0 }, undefined, false);
    expect(free.fracao).toBeUndefined();
    expect(free.gasto).toBe('40k tok');
  });

  it('acha a menção sendo digitada', () => {
    expect(mentionAt('veja @Co', 8)).toEqual({ kind: '@', query: 'Co', start: 5 });
    expect(mentionAt('abra #src/pi', 12)).toEqual({ kind: '#', query: 'src/pi', start: 5 });
    expect(mentionAt('email a@b', 9)).toBeUndefined();
    expect(mentionAt('nada', 4)).toBeUndefined();
  });

  it('anexa a última resposta de quem foi mencionado', () => {
    const answers = new Map([
      ['Codex', 'fiz o pix'],
      ['Claude Code', 'plano pronto'],
      ['Claude', ''],
    ]);
    const out = expandMentions('revise o que @Codex fez', answers);
    expect(out).toBe('revise o que @Codex fez\n\n---\nLast reply from Codex:\nfiz o pix');
    expect(expandMentions('@Claude Code e @Codex', answers)).toContain('plano pronto');
    expect(expandMentions('sem menção', answers)).toBe('sem menção');
    expect(expandMentions('@Codex', new Map([['Codex', 'x'.repeat(4001)]]))).toContain(
      '\n[…truncated]',
    );
  });
});

describe('Mesa em pt-BR', () => {
  afterEach(() => useLocale('en'));

  it('anexa a resposta e corta com o texto em português', () => {
    useLocale('pt-br');
    expect(expandMentions('veja @Codex', new Map([['Codex', 'fiz o pix']]))).toBe(
      'veja @Codex\n\n---\nÚltima resposta de Codex:\nfiz o pix',
    );
    expect(expandMentions('@Codex', new Map([['Codex', 'x'.repeat(4001)]]))).toContain(
      '\n[…cortado]',
    );
  });
});
