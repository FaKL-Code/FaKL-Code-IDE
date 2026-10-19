import { describe, expect, it } from 'vitest';

import {
  commandLine,
  IdleDetector,
  LineAssembler,
  quoteArg,
  resumeSuggestion,
  sanitizeTerminalInput,
  shellFlavor,
  stripAnsi,
  terminalCommandForProfile,
  terminalInputRefusal,
  TerminalStream,
} from '../src/index.js';

describe('terminal: ANSI para linhas', () => {
  it('tira cores, títulos e controles', () => {
    const bruto = '\u001b[1;32mok\u001b[0m \u001b]0;título\u0007feito\u001b[?25l\u0007';
    expect(stripAnsi(bruto)).toBe('ok feito');
  });

  it('monta linhas de pedaços cortados no meio de um escape', () => {
    const a = new LineAssembler();
    expect(a.push('um\u001b[3')).toEqual([]);
    expect(a.push('1mdois\u001b[0m\nter')).toEqual(['umdois']);
    expect(a.partial).toBe('ter');
    expect(a.push('ceira\r\n')).toEqual(['terceira']);
  });

  it('trata \\r como redesenho da linha e apaga com ESC[K', () => {
    const a = new LineAssembler();
    const linhas = a.push('baixando 10%\rbaixando 50%\r\u001b[Kbaixando 100%\n');
    expect(linhas).toEqual(['baixando 100%']);
  });

  it('entende backspace e avanço de cursor sem inventar texto', () => {
    const a = new LineAssembler();
    expect(a.push('abc\b\bX\u001b[2Cz\n')).toEqual(['aXc z']);
  });

  it('ignora sequências de dois caracteres e de conjunto de caracteres', () => {
    const a = new LineAssembler();
    expect(a.push('\u001b7\u001b(Bx\u001b8\n')).toEqual(['x']);
  });

  it('quebra uma linha sem fim para não crescer sem limite', () => {
    const a = new LineAssembler();
    const linhas = a.push('x'.repeat(4_500));
    expect(linhas.map((l) => l.length)).toEqual([2_000, 2_000]);
    expect(a.partial.length).toBe(500);
  });

  it('flush fecha a linha em andamento só quando ela tem texto', () => {
    const a = new LineAssembler();
    expect(a.flush()).toBeUndefined();
    a.push('> ');
    a.push('pergunta');
    expect(a.flush()).toBe('> pergunta');
    expect(a.partial).toBe('');
  });
});

describe('terminal: heurística de ocioso', () => {
  it('fica ocioso depois do silêncio, e a saída volta a ocupar', () => {
    const d = new IdleDetector({ silenceMs: 1_000 });
    d.started(0);
    expect(d.tick(500, '')).toBeUndefined();
    expect(d.tick(1_000, '')).toBe('ocioso');
    expect(d.tick(5_000, '')).toBeUndefined();
    expect(d.output(5_100)).toBe('executando');
    expect(d.output(5_200)).toBeUndefined();
  });

  it('com prompt, o silêncio sozinho não basta: a linha precisa casar', () => {
    const d = new IdleDetector({ silenceMs: 1_000, prompt: '^>\\s*$' });
    d.output(0);
    expect(d.tick(2_000, 'pensando...')).toBeUndefined();
    expect(d.tick(2_500, '>')).toBe('ocioso');
  });

  it('prompt inválido é ignorado e o silêncio decide', () => {
    const d = new IdleDetector({ silenceMs: 1_000, prompt: '(' });
    d.output(0);
    expect(d.tick(1_500, 'qualquer')).toBe('ocioso');
  });

  it('digitar conta como trabalho', () => {
    const d = new IdleDetector({ silenceMs: 1_000 });
    d.output(0);
    d.tick(2_000, '');
    expect(d.input(2_100)).toBe('executando');
  });
});

describe('terminal: extração de eventos do fluxo', () => {
  it('devolve linhas limpas sem as vazias e decide o estado', () => {
    const s = new TerminalStream({ silenceMs: 1_000, prompt: '>\\s*$' });
    s.start(0);
    const a = s.push('\u001b[32mpensando\u001b[0m\r\n\r\nresposta\r\n> ', 100);
    expect(a).toEqual({ lines: ['pensando', 'resposta'] });
    expect(s.tick(600).state).toBeUndefined();
    // Silêncio e prompt reconhecido: ocioso, e a linha do prompt sai junto.
    expect(s.tick(1_200)).toEqual({ lines: ['>'], state: 'ocioso' });
    expect(s.tick(5_000)).toEqual({ lines: [] });
  });

  it('um pedaço só de escapes não conta como saída', () => {
    const s = new TerminalStream({ silenceMs: 1_000 });
    s.start(0);
    s.push('x\n', 0);
    s.tick(2_000);
    expect(s.state).toBe('ocioso');
    expect(s.push('\u001b[?25h\u001b]0;t\u0007', 2_100)).toEqual({ lines: [] });
    expect(s.state).toBe('ocioso');
  });

  it('end devolve o que sobrou na linha', () => {
    const s = new TerminalStream();
    s.push('sem quebra', 0);
    expect(s.end()).toEqual({ lines: ['sem quebra'] });
  });
});

describe('terminal: política de entrada', () => {
  it('só aprovar-tudo deixa o Core digitar; os outros modos explicam o motivo', () => {
    expect(terminalInputRefusal('aprovar-tudo')).toBeUndefined();
    for (const modo of ['perguntar', 'aprovar-leitura'] as const) {
      expect(terminalInputRefusal(modo)).toContain('Assumir o agente');
    }
  });

  it('a mensagem vira uma linha sem escapes nem controles', () => {
    expect(sanitizeTerminalInput('a\nb\r\nc\u001b[2J\u0003d\t e ')).toBe('a b cd e');
    expect(sanitizeTerminalInput('\n\n')).toBe('');
  });
});

describe('terminal: montagem do comando', () => {
  it('vem só do perfil, com argumentos separados', () => {
    const cmd = terminalCommandForProfile({
      id: 'aider',
      nome: 'Aider',
      provedor: 'outro',
      adaptador: 'terminal',
      comando: ' aider ',
      args: ['--model', 'x y'],
      env: { A: '1' },
    });
    expect(cmd).toEqual({ command: 'aider', args: ['--model', 'x y'], env: { A: '1' } });
  });

  it('exige o comando', () => {
    expect(() =>
      terminalCommandForProfile({ id: 'x', nome: 'X', provedor: 'o', adaptador: 'terminal' }),
    ).toThrow(/comando/);
  });

  it('cita palavras para cada shell, só para texto que o usuário edita', () => {
    expect(quoteArg('abc-1.2/x', 'posix')).toBe('abc-1.2/x');
    expect(quoteArg("it's", 'posix')).toBe("'it'\\''s'");
    expect(quoteArg('a b', 'powershell')).toBe("'a b'");
    expect(quoteArg('a "b"', 'cmd')).toBe('"a ""b"""');
    expect(quoteArg('', 'posix')).toBe("''");
    expect(commandLine('claude', ['--resume', 'id 1'], 'posix')).toBe("claude --resume 'id 1'");
  });

  it('reconhece o shell pelo caminho', () => {
    expect(shellFlavor('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell');
    expect(shellFlavor('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellFlavor('/bin/zsh', 'linux')).toBe('posix');
    expect(shellFlavor(undefined, 'win32')).toBe('powershell');
  });

  it('sugere o comando de retomar a mesma sessão e marca o que não foi conferido', () => {
    expect(resumeSuggestion('anthropic', 'abc')).toEqual({
      command: 'claude',
      args: ['--resume', 'abc'],
      confirmed: true,
    });
    expect(resumeSuggestion('google', 'abc')).toMatchObject({
      command: 'gemini',
      args: ['--resume', 'latest'],
      confirmed: true,
    });
    expect(resumeSuggestion('openai', 'abc')).toEqual({
      command: 'codex',
      args: ['resume', 'abc'],
      confirmed: false,
    });
    expect(resumeSuggestion('outro', 'abc')).toBeUndefined();
  });
});
