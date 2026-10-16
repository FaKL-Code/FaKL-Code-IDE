import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeAccountsState, UsageWindowsResult } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activeSession,
  geminiWindows,
  pacificDayStart,
  parseGeminiLine,
  Router,
  UsageWindows,
  weekTotal,
  parseCodexLimits,
  type UsageSample,
} from '../src/index.js';

const call = { connectionId: 'c', notify: () => undefined, onClose: () => undefined };
const NOW = Date.parse('2026-10-15T15:30:00.000Z');
const HOUR = 3_600_000;

const claudeLine = (ts: number, tokens: number, id: string): string =>
  JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    requestId: id,
    sessionId: 'sessao',
    message: { id: `m${id}`, usage: { input_tokens: tokens, output_tokens: 0 } },
  });

describe('janelas de uso dos planos', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-windows-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function write(path: string[], lines: string[]): Promise<void> {
    await mkdir(join(home, ...path.slice(0, -1)), { recursive: true });
    await writeFile(join(home, ...path), `${lines.join('\n')}\n`);
  }

  it('sessão começa na hora cheia da primeira mensagem e dura 5 horas', () => {
    const samples: UsageSample[] = [
      { ts: Date.parse('2026-10-15T13:40:00.000Z'), tokens: 100 },
      { ts: Date.parse('2026-10-15T14:10:00.000Z'), tokens: 50 },
    ];
    expect(activeSession(samples, NOW)).toEqual({
      tokens: 150,
      resetaEm: Date.parse('2026-10-15T18:00:00.000Z'),
    });
    // Passada a janela, não há sessão ativa.
    expect(activeSession(samples, NOW + 6 * HOUR)).toBeUndefined();
    expect(weekTotal(samples, NOW)).toEqual({ tokens: 150 });
  });

  it('lê o percentual real do Codex', () => {
    const line = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { used_percent: 42, resets_at: 1_800_000_000 },
          secondary: { used_percent: 18 },
        },
      },
    });
    expect(parseCodexLimits(line)).toEqual({
      provedor: 'openai',
      sessao: { fracao: 0.42, resetaEm: 1_800_000_000_000 },
      semana: { fracao: 0.18 },
      origem: 'real',
    });
    expect(parseCodexLimits('{"payload":{}}')).toBeUndefined();
  });

  it('soma a sessão de 5 h e a semana do Claude e lê o Codex, sem inventar fonte', async () => {
    await write(
      ['.claude', 'projects', 'p', 'sessao.jsonl'],
      [
        claudeLine(NOW - 2 * HOUR, 1_000, 'a'),
        // A mesma resposta num arquivo de retomada não conta duas vezes.
        claudeLine(NOW - 2 * HOUR, 1_000, 'a'),
        claudeLine(NOW - 3 * 24 * HOUR, 5_000, 'b'),
        'linha que não é JSON',
      ],
    );
    await write(
      ['.codex', 'sessions', '2026', 'rollout.jsonl'],
      [
        JSON.stringify({
          payload: {
            rate_limits: {
              primary: { used_percent: 40, resets_at: Math.floor((NOW + HOUR) / 1000) },
              // Semana que já zerou: o percentual guardado não vale mais.
              secondary: { used_percent: 90, resets_at: Math.floor((NOW - HOUR) / 1000) },
            },
          },
        }),
      ],
    );
    const windows = new UsageWindows({ home, now: () => NOW });
    const router = new Router();
    windows.register(router);
    const result = (await router.dispatch('usage.windows', undefined, call)) as UsageWindowsResult;

    const claude = result.janelas.find((row) => row.provedor === 'anthropic');
    expect(claude).toMatchObject({ nome: 'Claude', origem: 'estimado' });
    expect(claude?.sessao?.tokens).toBe(1_000);
    expect(claude?.sessao?.resetaEm).toBeGreaterThan(NOW);
    expect(claude?.semana).toEqual({ tokens: 6_000 });

    const codex = result.janelas.find((row) => row.provedor === 'openai');
    expect(codex?.origem).toBe('real');
    expect(codex?.sessao?.fracao).toBeCloseTo(0.4);
    expect(codex?.semana).toBeUndefined();
  });

  it('uma linha por conta, a ativa primeiro, e nada onde não há registros', async () => {
    const slot1 = join(home, 'accounts', 'claude', '1');
    const slot2 = join(home, 'accounts', 'claude', '2');
    await mkdir(slot2, { recursive: true });
    await write(
      ['accounts', 'claude', '1', 'projects', 'p', 's.jsonl'],
      [claudeLine(NOW - HOUR, 700, 'x')],
    );
    const state: ClaudeAccountsState = {
      ativa: 1,
      contas: [
        { slot: 1, apelido: 'Pessoal', dir: slot1, logada: true, ativa: true, uso: zero() },
        { slot: 2, apelido: 'Trabalho', dir: slot2, logada: true, ativa: false, uso: zero() },
      ],
    };
    const windows = new UsageWindows({
      home,
      now: () => NOW,
      accounts: () => Promise.resolve(state),
    });
    const { janelas } = await windows.read();
    // A conta padrão e a do slot 2 não têm registros: só a ativa aparece.
    expect(janelas.map((row) => row.nome)).toEqual(['Pessoal']);
    expect(janelas[0]?.sessao?.tokens).toBe(700);
  });

  it('lê as respostas do Gemini CLI, sem repetir as reescritas da mesma mensagem', () => {
    const message = {
      id: 'g1',
      timestamp: '2026-10-15T15:00:00.000Z',
      type: 'gemini',
      content: 'texto que não é lido',
      tokens: { input: 1000, output: 50, cached: 600, thoughts: 10, tool: 0, total: 1060 },
      model: 'gemini-flash',
    };
    expect(parseGeminiLine(JSON.stringify(message))).toEqual([
      { ts: Date.parse(message.timestamp), tokens: 460, id: 'g1' },
    ]);
    const set = JSON.stringify({
      $set: { messages: [{ id: 'u1', type: 'user', timestamp: message.timestamp }, message] },
    });
    expect(parseGeminiLine(set)).toHaveLength(1);
    expect(parseGeminiLine('{"type":"user"}')).toEqual([]);
    expect(parseGeminiLine('quebrado "gemini"')).toEqual([]);
  });

  it('a cota do Gemini é do dia do Pacífico', () => {
    // 15:30 UTC em outubro = 08:30 no Pacífico (PDT, UTC-7).
    const start = pacificDayStart(NOW);
    expect(new Date(start).toISOString()).toBe('2026-10-15T07:00:00.000Z');
    const windows = geminiWindows(
      [
        { ts: Date.parse('2026-10-15T06:59:00.000Z'), tokens: 100 },
        { ts: Date.parse('2026-10-15T08:00:00.000Z'), tokens: 40 },
        { ts: Date.parse('2026-10-15T15:00:00.000Z'), tokens: 2 },
      ],
      NOW,
    );
    expect(windows).toEqual({
      provedor: 'google',
      dia: { requisicoes: 2, tokens: 42, resetaEm: Date.parse('2026-10-16T07:00:00.000Z') },
      semana: { tokens: 142 },
      origem: 'estimado',
    });
  });

  it('mostra o Gemini e marca sem dados o provedor configurado sem registro', async () => {
    const gemini = (id: string, ts: string, total: number): string =>
      JSON.stringify({ id, timestamp: ts, type: 'gemini', tokens: { total, cached: 0 } });
    await write(
      ['.gemini', 'tmp', 'projeto', 'chats', 'session-2026-10-15T14-00-abc.jsonl'],
      [
        JSON.stringify({ sessionId: 's', startTime: '2026-10-15T14:00:00.000Z' }),
        gemini('g1', '2026-10-15T14:00:00.000Z', 300),
        gemini('g1', '2026-10-15T14:00:00.000Z', 300),
        gemini('g2', '2026-10-15T14:05:00.000Z', 200),
      ],
    );
    const router = new Router();
    new UsageWindows({
      home,
      now: () => NOW,
      providers: () => ['google', 'openai', 'ollama'],
    }).register(router);
    const result = (await router.dispatch('usage.windows', undefined, call)) as UsageWindowsResult;
    expect(result.janelas).toEqual([
      {
        provedor: 'google',
        dia: { requisicoes: 2, tokens: 500, resetaEm: Date.parse('2026-10-16T07:00:00.000Z') },
        semana: { tokens: 500 },
        origem: 'estimado',
      },
      // Codex configurado, sem nenhum registro: aparece em vez de sumir. Local não tem cota.
      { provedor: 'openai', origem: 'estimado', semDados: true },
    ]);
  });
});

function zero(): ClaudeAccountsState['contas'][number]['uso'] {
  return { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
}
