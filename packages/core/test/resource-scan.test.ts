import { describe, expect, it } from 'vitest';

import { scanResource, type ResourceScanKind } from '../src/index.js';
import { BENIGNO, SUSPEITO } from './fixtures/varredura.js';

function scanText(content: string, tipo: ResourceScanKind = 'skill') {
  return scanResource({ tipo, nome: 'x', arquivos: [{ caminho: 'SKILL.md', conteudo: content }] });
}

function scanMcp(server: unknown) {
  return scanResource({
    tipo: 'mcp',
    nome: 'x',
    arquivos: [{ caminho: 'mcps.json', conteudo: JSON.stringify(server, null, 2) }],
  });
}

const rules = (risks: { regra: string }[]): string[] => risks.map((risk) => risk.regra);

describe('varredura de recursos: texto', () => {
  it.each([
    ['injecaoEn', 'prompt-injection'],
    ['injecaoEn2', 'prompt-injection'],
    ['injecaoPt', 'prompt-injection'],
    ['injecaoPt2', 'prompt-injection'],
  ] as const)('acha prompt injection em %s', (key, regra) => {
    const [risk] = scanText(`Linha 1\n${SUSPEITO[key]}\n`);
    expect(risk).toMatchObject({ regra, severidade: 'alta', arquivo: 'SKILL.md', linha: 2 });
    expect(risk?.trecho).toContain(SUSPEITO[key].slice(0, 20));
  });

  it('acha bidi (alta) e zero-width (média), mostrando o invisível como _', () => {
    expect(scanText(SUSPEITO.rlo)).toMatchObject([
      { regra: 'unicode-invisivel', severidade: 'alta', trecho: 'Arquivo de configura_ção segura' },
    ]);
    expect(scanText(SUSPEITO.zeroWidth)).toMatchObject([
      { regra: 'unicode-invisivel', severidade: 'media' },
    ]);
    expect(scanText(SUSPEITO.tag)).toMatchObject([
      { regra: 'unicode-invisivel', severidade: 'alta' },
    ]);
  });

  it('aceita BOM no começo do arquivo, mas não no meio', () => {
    expect(scanText('\uFEFF# Título\n')).toEqual([]);
    expect(rules(scanText('# Título\nmeio\uFEFFdo texto'))).toEqual(['unicode-invisivel']);
  });

  it('acha blob base64 longo (média), e imagem embutida só como baixa', () => {
    expect(scanText(SUSPEITO.base64)).toMatchObject([
      { regra: 'base64-longo', severidade: 'media' },
    ]);
    const image = `![x](data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(20)})`;
    expect(scanText(image)).toMatchObject([{ regra: 'base64-longo', severidade: 'baixa' }]);
    // Uma régua de traços ou um caminho longo não é base64.
    expect(scanText('-'.repeat(240))).toEqual([]);
    expect(scanText(`/${'pasta/'.repeat(40)}`)).toEqual([]);
  });

  it('acha baixar e executar (alta) e execução de texto (média ou baixa)', () => {
    expect(scanText(SUSPEITO.curlSh)).toMatchObject([
      { regra: 'baixa-e-executa', severidade: 'alta' },
    ]);
    expect(scanText(SUSPEITO.iwrIex)).toMatchObject([
      { regra: 'baixa-e-executa', severidade: 'alta' },
    ]);
    expect(scanText(SUSPEITO.invokeExpression)).toMatchObject([
      { regra: 'executa-texto', severidade: 'media' },
    ]);
    expect(scanText(SUSPEITO.evalShell)).toMatchObject([
      { regra: 'executa-texto', severidade: 'baixa' },
    ]);
  });

  it('acha envio para destino externo: alta com verbo de envio, média só citando', () => {
    expect(rules(scanText(SUSPEITO.webhook))).toEqual(['envio-externo']);
    expect(scanText(SUSPEITO.webhook)[0]?.severidade).toBe('alta');
    expect(scanText(SUSPEITO.ngrok)[0]).toMatchObject({
      regra: 'envio-externo',
      severidade: 'alta',
    });
    expect(scanText(SUSPEITO.pastebin)[0]).toMatchObject({
      regra: 'envio-externo',
      severidade: 'media',
    });
  });

  it('acha pedido de ler segredos, mais grave quando vai para a rede', () => {
    expect(scanText(SUSPEITO.leSegredos)[0]).toMatchObject({
      regra: 'le-segredos',
      severidade: 'media',
    });
    expect(scanText(SUSPEITO.leEnv)[0]).toMatchObject({
      regra: 'le-segredos',
      severidade: 'media',
    });
    expect(scanText(SUSPEITO.segredoParaFora)[0]).toMatchObject({
      regra: 'le-segredos',
      severidade: 'alta',
    });
    // Só citar o arquivo é baixa, e `.env.example` nem conta.
    expect(scanText(SUSPEITO.mencionaEnv)[0]).toMatchObject({
      regra: 'le-segredos',
      severidade: 'baixa',
    });
    expect(scanText('Copie .env.example para outro lugar')).toEqual([]);
  });

  it('acha o desligamento de confirmações', () => {
    expect(scanText(SUSPEITO.pulaPermissoes)[0]).toMatchObject({
      regra: 'sem-confirmacao',
      severidade: 'alta',
    });
    expect(scanText(SUSPEITO.semConfirmar)[0]).toMatchObject({
      regra: 'sem-confirmacao',
      severidade: 'media',
    });
  });

  it('não dá alta nem média para conteúdo benigno realista', () => {
    expect(scanText(BENIGNO.skillApi).filter((risk) => risk.severidade !== 'baixa')).toEqual([]);
    expect(scanText(BENIGNO.agenteRevisor, 'agent')).toEqual([]);
    // `curl` simples, sem pipe para shell e sem destino suspeito, não gera achado.
    expect(rules(scanText(BENIGNO.skillApi))).not.toContain('baixa-e-executa');
    expect(rules(scanText(BENIGNO.skillApi))).not.toContain('envio-externo');
  });

  it('ordena do mais grave ao menos, um achado por regra e linha, com linha e arquivo', () => {
    const text = [SUSPEITO.evalShell, SUSPEITO.curlSh, SUSPEITO.mencionaEnv].join('\n');
    const risks = scanText(text);
    expect(risks.map((risk) => [risk.severidade, risk.linha])).toEqual([
      ['alta', 2],
      ['baixa', 1],
      ['baixa', 3],
    ]);
    // Um achado por regra e linha: repetir o padrão na linha não duplica.
    expect(scanText(`${SUSPEITO.curlSh}; ${SUSPEITO.curlSh}`)).toHaveLength(1);
  });

  it('varre todos os arquivos da skill, não só o SKILL.md', () => {
    const risks = scanResource({
      tipo: 'skill',
      nome: 'x',
      arquivos: [
        { caminho: 'SKILL.md', conteudo: BENIGNO.skillApi },
        { caminho: 'scripts/setup.sh', conteudo: `#!/bin/sh\n${SUSPEITO.curlSh}\n` },
      ],
    });
    expect(risks[0]).toMatchObject({ arquivo: 'scripts/setup.sh', linha: 2, severidade: 'alta' });
  });
});

describe('varredura de recursos: MCP', () => {
  it('acha MCP stdio que roda shell', () => {
    expect(scanMcp(SUSPEITO.mcpShell)).toMatchObject([{ regra: 'mcp-shell', severidade: 'alta' }]);
    expect(scanMcp(SUSPEITO.mcpPowershell)).toMatchObject([
      { regra: 'mcp-shell', severidade: 'alta' },
    ]);
  });

  it('acha npx e uvx sem versão fixa, e deixa passar o que tem versão exata', () => {
    for (const server of [SUSPEITO.mcpNpxLivre, SUSPEITO.mcpNpxLatest, SUSPEITO.mcpUvxLivre]) {
      expect(scanMcp(server)).toMatchObject([{ regra: 'mcp-sem-versao', severidade: 'baixa' }]);
    }
    expect(scanMcp(BENIGNO.mcpPinado)).toEqual([]);
    expect(scanMcp(SUSPEITO.mcpUvxPinado)).toEqual([]);
  });

  it('acha MCP http para túnel, IP ou http puro; deixa passar https comum e localhost', () => {
    expect(scanMcp(SUSPEITO.mcpTunel)).toMatchObject([
      { regra: 'mcp-dominio-estranho', severidade: 'alta' },
    ]);
    expect(scanMcp(SUSPEITO.mcpIp)).toMatchObject([
      { regra: 'mcp-dominio-estranho', severidade: 'media' },
    ]);
    expect(scanMcp(SUSPEITO.mcpHttpPuro)).toMatchObject([
      { regra: 'mcp-dominio-estranho', severidade: 'media' },
    ]);
    expect(scanMcp(BENIGNO.mcpHttp)).toEqual([]);
    expect(scanMcp(BENIGNO.mcpLocal)).toEqual([]);
  });

  it('varre também o texto da definição (comando com curl e pipe para shell)', () => {
    const risks = scanMcp({ command: 'sh', args: ['-c', SUSPEITO.curlSh] });
    expect(rules(risks)).toEqual(expect.arrayContaining(['mcp-shell', 'baixa-e-executa']));
  });

  it('JSON inválido não quebra', () => {
    expect(
      scanResource({
        tipo: 'mcp',
        nome: 'x',
        arquivos: [{ caminho: 'mcps.json', conteudo: '{ não é json' }],
      }),
    ).toEqual([]);
  });
});
