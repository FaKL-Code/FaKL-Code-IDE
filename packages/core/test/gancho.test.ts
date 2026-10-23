import { describe, expect, it } from 'vitest';

import type { AgentProfile } from '@fakl/agents';

import {
  estadoInicial,
  exploradorDe,
  ganchosDaEconomia,
  nivelDelegado,
  processarGancho,
  aspasSh,
  type EntradaDoGancho,
} from '../src/index.js';

const bash = (stdout: string, command = 'pnpm test'): EntradaDoGancho => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
});

const read = (content: string, agent?: string): EntradaDoGancho => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  tool_name: 'Read',
  tool_input: { file_path: '/repo/a.ts' },
  tool_response: {
    type: 'text',
    file: { filePath: '/repo/a.ts', content, numLines: 1, startLine: 1, totalLines: 1 },
  },
  ...(agent ? { agent_id: agent } : {}),
});

interface Saida {
  hookSpecificOutput: {
    hookEventName: string;
    updatedToolOutput?: { stdout?: string; stderr?: string; file?: { content: string } };
    additionalContext?: string;
  };
}

describe('gancho da economia no Claude Code', () => {
  it('desligado, não muda nada', () => {
    const estado = estadoInicial();
    const saida = 'linha igual\n'.repeat(50);
    expect(processarGancho(bash(saida), estado, { modo: 'desligado' })).toEqual({});
  });

  it('compacta a saída do Bash e conta o que economizou', () => {
    const estado = estadoInicial();
    const saida = `\u001b[32mok\u001b[0m\n${'baixando pacote\n'.repeat(40)}fim`;
    const resultado = processarGancho(bash(saida), estado, { modo: 'equilibrado' });
    const out = (resultado.saida as Saida).hookSpecificOutput;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.updatedToolOutput?.stdout).toContain('[linha acima repetida 40 vezes]');
    expect(out.updatedToolOutput?.stdout).not.toContain('\u001b');
    expect(estado.somas.respostas).toBe(1);
    expect(estado.somas.caracteresCompactados).toBeGreaterThan(500);
  });

  it('troca por um aviso a leitura idêntica com a mesma saída, só no mesmo contexto', () => {
    const estado = estadoInicial();
    const config = { modo: 'equilibrado' as const };
    const conteudo = 'export const x = 1;\n'.repeat(100);
    expect(processarGancho(read(conteudo), estado, config)).toEqual({});
    const repetida = processarGancho(read(conteudo), estado, config);
    const out = (repetida.saida as Saida).hookSpecificOutput;
    expect(out.updatedToolOutput?.file?.content).toMatch(/^\[FaKL economia: mesma saída/);
    expect(estado.somas.repeticoes).toBe(1);
    // Um subagente tem outro contexto: a primeira leitura dele é inteira.
    expect(processarGancho(read(conteudo, 'sub-1'), estado, config)).toEqual({});
    // O arquivo mudou: a saída é outra e vai inteira.
    expect(processarGancho(read(`${conteudo}y`), estado, config)).toEqual({});
  });

  it('saída curta repetida não vira aviso', () => {
    const estado = estadoInicial();
    const config = { modo: 'agressivo' as const };
    processarGancho(read('curto'), estado, config);
    expect(processarGancho(read('curto'), estado, config)).toEqual({});
  });

  it('depois de compactar a conversa, a leitura repetida volta inteira', () => {
    const estado = estadoInicial();
    const config = { modo: 'equilibrado' as const };
    const conteudo = 'a'.repeat(5_000);
    processarGancho(read(conteudo), estado, config);
    processarGancho({ hook_event_name: 'PreCompact' }, estado, config);
    expect(processarGancho(read(conteudo), estado, config)).toEqual({});
  });

  it('lembra do explorador quando a conversa principal lê demais na rodada', () => {
    const estado = estadoInicial();
    const config = { modo: 'agressivo' as const, explorador: 'explorador' };
    const busca = (n: number, agent?: string): EntradaDoGancho => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: `p${String(n)}` },
      tool_response: { mode: 'files_with_matches', filenames: [] },
      ...(agent ? { agent_id: agent } : {}),
    });
    for (let i = 1; i <= 3; i += 1) expect(processarGancho(busca(i), estado, config)).toEqual({});
    // As do subagente não contam.
    expect(processarGancho(busca(9, 'sub'), estado, config)).toEqual({});
    const quarta = (processarGancho(busca(4), estado, config).saida as Saida).hookSpecificOutput;
    expect(quarta.additionalContext).toContain('subagente `explorador`');
    expect(quarta.updatedToolOutput).toBeUndefined();
    // Nova mensagem, nova rodada.
    processarGancho({ hook_event_name: 'UserPromptSubmit' }, estado, config);
    expect(estado.exploracao).toBe(0);
    // Sem explorador, não há o que lembrar.
    const sem = estadoInicial();
    for (let i = 1; i <= 8; i += 1) {
      expect(processarGancho(busca(i), sem, { modo: 'agressivo' })).toEqual({});
    }
  });

  it('no fim da rodada manda as somas ao Core e zera', () => {
    const estado = estadoInicial();
    expect(processarGancho({ hook_event_name: 'Stop' }, estado, { modo: 'equilibrado' })).toEqual(
      {},
    );
    processarGancho(bash('x\n'.repeat(30)), estado, { modo: 'equilibrado' });
    const fim = processarGancho({ hook_event_name: 'Stop' }, estado, { modo: 'equilibrado' });
    expect(fim.registrar?.respostas).toBe(1);
    expect(estado.somas.respostas).toBe(0);
  });

  it('monta os ganchos e as aspas do sh', () => {
    const ganchos = ganchosDaEconomia('node gancho.mjs') as Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >;
    expect(ganchos.PostToolUse?.[0]?.matcher).toBe('Bash|Read|Grep|Glob');
    expect(ganchos.Stop?.[0]?.hooks[0]?.command).toBe('node gancho.mjs');
    expect(aspasSh(String.raw`\\.\pipe\fakl`)).toBe(String.raw`'\\.\pipe\fakl'`);
    expect(aspasSh("it's")).toBe(`'it'\\''s'`);
  });
});

describe('explorador barato', () => {
  const perfil = (
    id: string,
    custoRelativo: AgentProfile['custoRelativo'],
    extra: Record<string, unknown> = {},
  ): AgentProfile =>
    ({
      id,
      nome: id,
      provedor: 'anthropic',
      adaptador: 'acp',
      modelo: `${id}-modelo`,
      custoRelativo,
      ...extra,
    }) as AgentProfile;
  const haiku = perfil('haiku', 'baixo');
  const sonnet = perfil('sonnet', 'médio');
  const opus = perfil('opus', 'alto');
  const perfis = [haiku, sonnet, opus];

  it('usa o modelo do perfil do Claude mais barato que a sessão', () => {
    expect(exploradorDe(opus, perfis)).toBe('haiku-modelo');
    expect(exploradorDe(sonnet, perfis)).toBe('haiku-modelo');
    expect(exploradorDe(haiku, perfis)).toBeUndefined();
  });

  it('ignora perfis de outro provedor ou sem modelo', () => {
    const outros = [
      perfil('gemini', 'baixo', { provedor: 'google' }),
      perfil('semmodelo', 'baixo', { modelo: undefined }),
      sonnet,
    ];
    expect(exploradorDe(sonnet, outros)).toBeUndefined();
  });
});

describe('parte delegada', () => {
  it('desce um nível de complexidade', () => {
    expect(nivelDelegado('alta')).toBe('media');
    expect(nivelDelegado('media')).toBe('baixa');
    expect(nivelDelegado('baixa')).toBe('baixa');
  });
});
