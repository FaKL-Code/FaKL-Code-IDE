import type { McpProbe, ProviderStatus } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  actionOf,
  diagnose,
  doctorSummary,
  firstConcern,
  geminiPersonalLogin,
  nodeMajor,
  type DoctorItem,
  type DoctorSnapshot,
} from '../src/doctor-model.js';
import { escapeHtml, renderDoctor } from '../src/doctor-view.js';

// Retratos sintéticos: nenhuma credencial, nenhum arquivo de login lido.
const provider = (over: Partial<ProviderStatus> & { id: string }): ProviderStatus => ({
  nome: over.id,
  tipo: 'cli',
  instalado: false,
  chave: false,
  pronto: false,
  perfis: [],
  ...over,
});

const claudePronto = provider({
  id: 'anthropic',
  nome: 'Claude Code',
  instalado: true,
  cliInstalado: true,
  logado: true,
  modo: 'assinatura',
  pronto: true,
  versao: '2.1.0',
  chaveEnv: 'ANTHROPIC_API_KEY',
});
const codexAusente = provider({
  id: 'openai',
  nome: 'Codex',
  instalar: 'npm install -g @agentclientprotocol/codex-acp && npm install -g @openai/codex',
  login: 'codex login',
  chaveEnv: 'OPENAI_API_KEY',
});
const geminiAusente = provider({
  id: 'google',
  nome: 'Gemini CLI',
  instalar: 'npm install -g @google/gemini-cli',
  login: 'gemini',
  chaveEnv: 'GEMINI_API_KEY',
});

const ambiente = { node: '22.13.0', npm: '10.9.0', chavesNoAmbiente: [] as string[] };
const snap = (over: Partial<DoctorSnapshot> = {}): DoctorSnapshot => ({
  conectado: true,
  ambiente,
  provedores: [claudePronto, codexAusente, geminiAusente],
  ...over,
});

const byId = (items: readonly DoctorItem[], id: string): DoctorItem => {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`sem item ${id}: ${items.map((item) => item.id).join(', ')}`);
  return found;
};

describe('nodeMajor', () => {
  it('lê o major com ou sem o v', () => {
    expect(nodeMajor('22.13.0')).toBe(22);
    expect(nodeMajor('v20.1.0')).toBe(20);
    expect(nodeMajor('abc')).toBeUndefined();
  });
});

describe('diagnose: Node e npm', () => {
  it('Node e npm em versão aceita ficam ok', () => {
    const items = diagnose(snap());
    expect(byId(items, 'node').severidade).toBe('ok');
    expect(byId(items, 'npm').severidade).toBe('ok');
  });

  it('sem Node é problema, com o link de download', () => {
    const items = diagnose(snap({ ambiente: { chavesNoAmbiente: [] } }));
    const node = byId(items, 'node');
    expect(node.severidade).toBe('problema');
    expect(node.acoes[0]).toMatchObject({ tipo: 'link' });
    // Sem Node, a falta do npm é só consequência.
    expect(byId(items, 'npm').severidade).toBe('info');
  });

  it('Node antigo avisa e pede uma versão atual', () => {
    const node = byId(diagnose(snap({ ambiente: { ...ambiente, node: '18.20.4' } })), 'node');
    expect(node.severidade).toBe('aviso');
    expect(node.detalhe).toContain('20');
  });

  it('Node presente sem npm: o npm é problema', () => {
    const items = diagnose(snap({ ambiente: { node: '22.13.0', chavesNoAmbiente: [] } }));
    expect(byId(items, 'npm').severidade).toBe('problema');
  });
});

describe('diagnose: provedores', () => {
  it('provedor pronto e em dia vira um item ok; os ausentes são só nota quando há outro pronto', () => {
    const items = diagnose(snap());
    expect(byId(items, 'anthropic.ok').severidade).toBe('ok');
    expect(byId(items, 'agentes').severidade).toBe('ok');
    expect(byId(items, 'openai.instalacao').severidade).toBe('info');
    expect(byId(items, 'google.instalacao').severidade).toBe('info');
  });

  it('sem nenhum provedor pronto, cada falta vira problema', () => {
    const items = diagnose(snap({ provedores: [codexAusente, geminiAusente] }));
    expect(byId(items, 'agentes').severidade).toBe('problema');
    expect(byId(items, 'openai.instalacao').severidade).toBe('problema');
  });

  it('a instalação oferece o comando exato num terminal, sem rodar', () => {
    const item = byId(diagnose(snap()), 'openai.instalacao');
    expect(item.acoes[0]).toMatchObject({
      tipo: 'terminal',
      texto: 'npm install -g @agentclientprotocol/codex-acp && npm install -g @openai/codex',
    });
  });

  it('adaptador instalado e CLI oficial ausente: pede o CLI ou a chave', () => {
    const claude = provider({
      ...claudePronto,
      cliInstalado: false,
      logado: false,
      pronto: false,
      instalar: 'npm install -g @anthropic-ai/claude-code',
    });
    const item = byId(diagnose(snap({ provedores: [claude] })), 'anthropic.cli');
    expect(item.acoes.map((action) => action.tipo)).toEqual(['terminal', 'comando']);
    expect(item.acoes[1]).toMatchObject({ comando: 'fakl.providers.setKey', args: ['anthropic'] });
  });

  it('CLI instalado sem login oferece o comando de login e a chave', () => {
    const codex = provider({
      ...codexAusente,
      instalado: true,
      cliInstalado: true,
      logado: false,
    });
    const item = byId(diagnose(snap({ provedores: [codex] })), 'openai.login');
    expect(item.severidade).toBe('problema');
    expect(item.acoes[0]).toMatchObject({ tipo: 'terminal', texto: 'codex login' });
    expect(item.acoes[1]).toMatchObject({ comando: 'fakl.providers.setKey' });
  });

  it('com chave guardada o CLI oficial não faz falta', () => {
    const claude = provider({
      ...claudePronto,
      cliInstalado: false,
      chave: true,
      modo: 'chave',
      logado: false,
    });
    const items = diagnose(snap({ provedores: [claude] }));
    expect(items.some((item) => item.id === 'anthropic.cli')).toBe(false);
    expect(byId(items, 'anthropic.ok').severidade).toBe('ok');
  });

  it('versão desatualizada do adaptador vira aviso com o comando de atualizar', () => {
    const claude = provider({
      ...claudePronto,
      atualizacoes: [
        {
          pacote: '@agentclientprotocol/claude-agent-acp',
          comando: 'claude-agent-acp',
          papel: 'adaptador',
          instalada: '1.0.0',
          ultima: '1.2.0',
          desatualizada: true,
          atualizar: 'npm install -g @agentclientprotocol/claude-agent-acp@latest',
        },
        {
          pacote: '@anthropic-ai/claude-code',
          comando: 'claude',
          papel: 'cli',
          instalada: '2.1.0',
          ultima: '2.1.0',
          desatualizada: false,
          atualizar: 'npm install -g @anthropic-ai/claude-code@latest',
        },
      ],
    });
    const items = diagnose(snap({ provedores: [claude] }));
    const update = byId(items, 'anthropic.adaptador.atualizacao');
    expect(update.severidade).toBe('aviso');
    expect(update.detalhe).toContain('1.0.0');
    expect(update.acoes[0]).toMatchObject({
      tipo: 'terminal',
      texto: 'npm install -g @agentclientprotocol/claude-agent-acp@latest',
    });
    expect(items.some((item) => item.id === 'anthropic.cli.atualizacao')).toBe(false);
    // Com algo velho, o item "pronto" não aparece.
    expect(items.some((item) => item.id === 'anthropic.ok')).toBe(false);
  });
});

describe('diagnose: Gemini', () => {
  const gemini = provider({
    id: 'google',
    nome: 'Gemini CLI',
    instalado: true,
    cliInstalado: true,
    logado: true,
    modo: 'assinatura',
    pronto: true,
    loginTipo: 'oauth-personal',
    chaveEnv: 'GEMINI_API_KEY',
    login: 'gemini',
  });

  it('login de conta Google pessoal é problema mesmo "logado", com a chave de API como saída', () => {
    expect(geminiPersonalLogin(gemini)).toBe(true);
    const items = diagnose(snap({ provedores: [gemini] }));
    const item = byId(items, 'google.login');
    expect(item.severidade).toBe('problema');
    expect(item.detalhe).toContain('personal');
    expect(item.acoes[0]).toMatchObject({ comando: 'fakl.providers.setKey', args: ['google'] });
    expect(item.acoes[1]).toMatchObject({ tipo: 'link' });
    // E ele não conta como agente pronto.
    expect(byId(items, 'agentes').severidade).toBe('problema');
    expect(items.some((candidate) => candidate.id === 'google.ok')).toBe(false);
  });

  it('com chave de API no cofre o login pessoal deixa de importar', () => {
    const withKey = provider({ ...gemini, chave: true, modo: 'chave' });
    expect(geminiPersonalLogin(withKey)).toBe(false);
    const items = diagnose(snap({ provedores: [withKey] }));
    expect(items.some((item) => item.id === 'google.login')).toBe(false);
    expect(byId(items, 'google.ok').severidade).toBe('ok');
  });

  it('login por Vertex ou chave não dispara o aviso', () => {
    expect(geminiPersonalLogin(provider({ ...gemini, loginTipo: 'vertex-ai' }))).toBe(false);
    expect(geminiPersonalLogin(provider({ ...gemini, loginTipo: 'gemini-api-key' }))).toBe(false);
  });
});

describe('diagnose: chave só no ambiente e Docker', () => {
  it('chave no ambiente que não está no cofre vira aviso com a ação de guardar', () => {
    const items = diagnose(snap({ ambiente: { ...ambiente, chavesNoAmbiente: ['google'] } }));
    const item = byId(items, 'google.chave-ambiente');
    expect(item.severidade).toBe('aviso');
    expect(item.titulo).toContain('GEMINI_API_KEY');
    expect(item.acoes[0]).toMatchObject({ comando: 'fakl.providers.setKey', args: ['google'] });
  });

  it('chave já guardada no cofre não gera aviso', () => {
    const withKey = provider({ ...geminiAusente, chave: true });
    const items = diagnose(
      snap({
        ambiente: { ...ambiente, chavesNoAmbiente: ['google'] },
        provedores: [claudePronto, withKey],
      }),
    );
    expect(items.some((item) => item.id === 'google.chave-ambiente')).toBe(false);
  });

  it('o Docker sempre aparece como não necessário, com o guia do relay', () => {
    for (const snapshot of [snap(), snap({ provedores: [] }), { conectado: false }]) {
      const docker = byId(diagnose(snapshot), 'docker');
      expect(docker.severidade).toBe('info');
      expect(docker.titulo).toContain('not needed');
      expect(docker.acoes[0]).toMatchObject({ tipo: 'link' });
    }
  });
});

describe('diagnose: servidor MCP da FaKL', () => {
  const withMcp = (mcp: McpProbe) => diagnose(snap({ ambiente: { ...ambiente, mcp } }));

  it('respondendo: ok, sem ação', () => {
    const item = byId(withMcp({ ok: true, ferramentas: 7 }), 'mcp');
    expect(item.severidade).toBe('ok');
    expect(item.titulo).toBe('FaKL MCP server: ok');
    expect(item.detalhe).toContain('7');
    expect(item.acoes).toEqual([]);
  });

  it('saída com código e stderr: mostra o motivo, as últimas linhas e a correção', () => {
    const item = byId(
      withMcp({
        ok: false,
        motivo: 'saiu',
        codigo: 2,
        stderr: ['a', 'b', 'c', 'd'].join(String.fromCharCode(10)),
      }),
      'mcp',
    );
    expect(item.severidade).toBe('aviso');
    expect(item.detalhe).toContain('code 2');
    expect(item.detalhe).toContain('b | c | d');
    expect(item.detalhe).not.toContain('a |');
    expect(item.detalhe).toContain('Maestro tools do not show up');
    expect(item.acoes[0]).toMatchObject({ comando: 'workbench.action.reloadWindow' });
  });

  it('comando não encontrado e sem resposta têm frases próprias', () => {
    expect(byId(withMcp({ ok: false, motivo: 'nao-encontrado' }), 'mcp').detalhe).toContain(
      'not found',
    );
    expect(byId(withMcp({ ok: false, motivo: 'sem-resposta' }), 'mcp').detalhe).toContain(
      'did not answer',
    );
  });

  it('sem o teste (Core sem servidor MCP) não aparece item', () => {
    expect(diagnose(snap()).some((item) => item.id === 'mcp')).toBe(false);
  });
});

describe('diagnose: sem Core', () => {
  it('só avisa do Core e do Docker, sem inventar o resto', () => {
    const items = diagnose({ conectado: false });
    expect(items.map((item) => item.id)).toEqual(['core', 'docker']);
    expect(items[0]?.acoes[0]).toMatchObject({ comando: 'workbench.action.reloadWindow' });
  });
});

describe('resumo e ação', () => {
  it('conta problemas e avisos e acha o que mais pesa', () => {
    const items = diagnose(
      snap({
        ambiente: { ...ambiente, node: '18.0.0', chavesNoAmbiente: ['google'] },
        provedores: [codexAusente, geminiAusente],
      }),
    );
    expect(doctorSummary(items).problemas).toBeGreaterThan(0);
    expect(doctorSummary(items).avisos).toBe(2);
    expect(firstConcern(items)?.severidade).toBe('problema');
    expect(firstConcern(diagnose(snap()))).toBeUndefined();
  });

  it('a página só alcança as ações que a tela mostrou', () => {
    const items = diagnose(snap());
    expect(actionOf(items, 'openai.instalacao', 0)).toBeDefined();
    expect(actionOf(items, 'openai.instalacao', 5)).toBeUndefined();
    expect(actionOf(items, 'nao-existe', 0)).toBeUndefined();
  });

  it('nenhum texto do diagnóstico leva emoji', () => {
    const everything = diagnose(snap({ ambiente: { ...ambiente, chavesNoAmbiente: ['google'] } }));
    expect(/\p{Extended_Pictographic}/u.test(JSON.stringify(everything))).toBe(false);
  });
});

describe('renderDoctor', () => {
  const options = { nonce: 'abc', cspSource: 'x', language: 'en', loading: false };

  it('escapa o que vem do ambiente e liga cada botão ao item e ao índice', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    const html = renderDoctor(diagnose(snap()), options);
    expect(html).toContain('data-item="openai.instalacao" data-indice="0"');
    expect(html).toContain("script-src 'nonce-abc'");
  });

  it('mostra o estado de leitura enquanto espera', () => {
    const html = renderDoctor([], { ...options, loading: true });
    expect(html).toContain('Checking this computer');
    expect(html).not.toContain('class="item');
  });
});
