import type { AgentTerminalLine, AgentTerminalLinesParams } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  readOnlyNotice,
  TerminalFeed,
  terminalText,
  terminalTitle,
} from '../src/terminal-model.js';

const linha = (seq: number, text = `linha ${seq}`): AgentTerminalLine => ({
  seq,
  ts: '2026-10-18T10:00:00.000Z',
  text,
});

const novas = (...lines: AgentTerminalLine[]): AgentTerminalLinesParams => ({
  sessionId: 's1',
  lines,
  state: 'executando',
});

describe('terminal de leitura: modelo', () => {
  it('usa CRLF, que é o que o Pseudoterminal exige', () => {
    expect(terminalText([linha(1), linha(2)])).toBe('linha 1\r\nlinha 2\r\n');
    expect(terminalText([])).toBe('');
  });

  it('avisa que é somente leitura', () => {
    expect(readOnlyNotice()).toContain('Read-only terminal');
    expect(readOnlyNotice().endsWith('\r\n')).toBe(true);
  });

  it('nomeia a aba pelo agente e desempata sessões de mesmo nome', () => {
    expect(terminalTitle('Claude Code', '01ABCDEFGH', new Set())).toBe('Terminal: Claude Code');
    expect(terminalTitle('Claude Code', '01ABCDEFGH', new Set(['Terminal: Claude Code']))).toBe(
      'Terminal: Claude Code (CDEFGH)',
    );
  });

  it('escreve o histórico e depois só as linhas novas, sem repetir', () => {
    const feed = new TerminalFeed();
    feed.begin();
    expect(
      feed.history({
        sessionId: 's1',
        lines: [linha(1), linha(2)],
        state: 'executando',
        dropped: 0,
      }),
    ).toBe('linha 1\r\nlinha 2\r\n');
    expect(feed.push(novas(linha(3)))).toBe('linha 3\r\n');
    expect(feed.push(novas(linha(3), linha(4)))).toBe('linha 4\r\n');
  });

  it('segura notificações que chegam antes do histórico, na ordem certa', () => {
    const feed = new TerminalFeed();
    feed.begin();
    expect(feed.push(novas(linha(3)))).toBe('');
    expect(feed.push(novas(linha(4)))).toBe('');
    const out = feed.history({
      sessionId: 's1',
      lines: [linha(1), linha(2), linha(3)],
      state: 'executando',
      dropped: 0,
    });
    expect(out).toBe('linha 1\r\nlinha 2\r\nlinha 3\r\nlinha 4\r\n');
  });

  it('ao reconectar mostra só o que faltava', () => {
    const feed = new TerminalFeed();
    feed.begin();
    feed.history({ sessionId: 's1', lines: [linha(1), linha(2)], state: 'executando', dropped: 0 });
    feed.begin();
    expect(
      feed.history({
        sessionId: 's1',
        lines: [linha(1), linha(2), linha(3)],
        state: 'concluído',
        dropped: 0,
      }),
    ).toBe('linha 3\r\n');
    expect(feed.state).toBe('concluído');
  });

  it('se o Core reiniciou e a numeração voltou, mostra tudo de novo', () => {
    const feed = new TerminalFeed();
    feed.begin();
    feed.history({
      sessionId: 's1',
      lines: [linha(1), linha(2), linha(3)],
      state: 'executando',
      dropped: 0,
    });
    feed.begin();
    expect(
      feed.history({ sessionId: 's1', lines: [linha(1, 'nova')], state: 'executando', dropped: 0 }),
    ).toBe('nova\r\n');
  });

  it('avisa quando linhas antigas já saíram do buffer', () => {
    const feed = new TerminalFeed();
    feed.begin();
    const out = feed.history({
      sessionId: 's1',
      lines: [linha(11)],
      state: 'executando',
      dropped: 10,
    });
    expect(out).toContain('10 earlier lines');
    expect(out).toContain('linha 11');
  });
});
