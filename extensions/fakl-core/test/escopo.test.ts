import { describe, expect, it } from 'vitest';

import { AgentBoard } from '../src/board.js';
import { naPasta, pastasLocais } from '../src/escopo.js';

describe('escopo por pasta', () => {
  it('só passa o que está na pasta aberta ou dentro dela', () => {
    const pastas = ['C:/dev/app'];
    expect(naPasta('C:/dev/app', pastas, true)).toBe(true);
    expect(naPasta('c:/dev/app/pacotes/x', pastas, true)).toBe(true);
    expect(naPasta('C:/dev/app-outro', pastas, true)).toBe(false);
    expect(naPasta('C:/dev/outra', pastas, true)).toBe(false);
    expect(naPasta(undefined, pastas, true)).toBe(false);
  });

  it('respeita maiúsculas onde o disco as distingue', () => {
    expect(naPasta('/srv/App', ['/srv/app'], false)).toBe(false);
    expect(naPasta('/srv/app/x', ['/srv/app/'], false)).toBe(true);
  });

  it('sem pasta local aberta não há o que isolar', () => {
    expect(naPasta('/qualquer', [], false)).toBe(true);
  });

  it('pastasLocais ignora as remotas', () => {
    expect(
      pastasLocais([
        { uri: { scheme: 'file', fsPath: '/a' } },
        { uri: { scheme: 'fakl-ssh', fsPath: '/b' } },
      ]),
    ).toEqual(['/a']);
  });

  it('o quadro de sessões esconde as de outro projeto, mas as guarda', () => {
    const session = (sessionId: string, cwd: string) =>
      ({
        sessionId,
        profileId: 'p',
        nome: 'n',
        cwd,
        state: 'working',
        usage: {},
        permissoes: 'perguntar',
        opcoes: [],
      }) as never;
    const board = new AgentBoard((s) => naPasta(s.cwd, ['/a'], false));
    board.load([session('1', '/a'), session('2', '/b')]);
    expect(board.list().map((s) => s.sessionId)).toEqual(['1']);
    expect(board.totals().active).toBe(1);
    expect(board.get('2')).toBeDefined();
  });
});
