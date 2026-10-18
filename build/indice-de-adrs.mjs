#!/usr/bin/env node
// Mantém a tabela de ADRs de docs/README.md igual à pasta docs/adr: uma linha por arquivo,
// ordenada, com um único cabeçalho. Duas PRs que acrescentam linha ao mesmo tempo geram
// conflito, e resolvê-lo à mão já duplicou a tabela e perdeu linhas; este script refaz tudo.
//
// Uso: node build/indice-de-adrs.mjs            confere e sai com 1 se estiver diferente
//      node build/indice-de-adrs.mjs --escrever reescreve a tabela (depois rode o prettier)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADRS = join(RAIZ, 'docs', 'adr');
const INDICE = join(RAIZ, 'docs', 'README.md');
const CABECALHO = ['| ADR | Decisão |', '| --- | --- |'];

/** Arquivos de ADR (sem o modelo), em ordem. */
export function arquivosDeAdr(pasta = ADRS) {
  return readdirSync(pasta)
    .filter((nome) => /^\d{4}-.+\.md$/.test(nome) && !nome.startsWith('0000-'))
    .sort();
}

/** `{ arquivo: descrição }` das linhas de tabela do índice (a última vence). */
export function descricoesDoIndice(texto) {
  const mapa = {};
  for (const linha of texto.split(/\r?\n/)) {
    const achado = /^\|\s*\[(\d{4})\]\(adr\/([^)]+\.md)\)\s*\|\s*(.+?)\s*\|\s*$/.exec(linha);
    if (achado) mapa[achado[2]] = achado[3];
  }
  return mapa;
}

/** Título do ADR: o texto depois de `# NNNN. ` na primeira linha. */
export function tituloDoAdr(conteudo) {
  return /^#\s*\d{4}\.\s*(.+?)\s*$/m.exec(conteudo)?.[1];
}

/** Monta a tabela: uma linha por ADR, com a descrição que o índice já tinha ou o título. */
export function montarTabela(arquivos, descricoes, titulos) {
  const linhas = arquivos.map((arquivo) => {
    const numero = arquivo.slice(0, 4);
    const texto = descricoes[arquivo] ?? titulos[arquivo] ?? arquivo;
    return `| [${numero}](adr/${arquivo}) | ${texto} |`;
  });
  return [...CABECALHO, ...linhas].join('\n');
}

/** Troca todo o bloco de tabelas de ADR do índice pela tabela nova, sem mexer no resto. */
export function reescreverIndice(texto, tabela) {
  const linhas = texto.split(/\r?\n/);
  const eTabela = (linha) => /^\|/.test(linha);
  const inicio = linhas.findIndex((linha) => /^\|\s*ADR\s*\|/.test(linha));
  if (inicio < 0) throw new Error('docs/README.md sem a tabela de ADRs');
  let fim = inicio;
  while (fim < linhas.length && eTabela(linhas[fim])) fim += 1;
  return [...linhas.slice(0, inicio), ...tabela.split('\n'), ...linhas.slice(fim)].join('\n');
}

export function carregar() {
  const texto = readFileSync(INDICE, 'utf8');
  const arquivos = arquivosDeAdr();
  const titulos = Object.fromEntries(
    arquivos.map((arquivo) => [arquivo, tituloDoAdr(readFileSync(join(ADRS, arquivo), 'utf8'))]),
  );
  return { texto, arquivos, descricoes: descricoesDoIndice(texto), titulos };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { texto, arquivos, descricoes, titulos } = carregar();
  const novo = reescreverIndice(texto, montarTabela(arquivos, descricoes, titulos));
  if (process.argv.includes('--escrever')) {
    writeFileSync(INDICE, novo);
    console.log(`índice de ADRs reescrito: ${arquivos.length} linhas`);
  } else {
    const conta = (t) => t.split(/\r?\n/).filter((l) => /^\|\s*\[\d{4}\]/.test(l)).length;
    const ok =
      conta(texto) === arquivos.length &&
      texto.split(/\r?\n/).filter((l) => /^\|\s*ADR\s*\|/.test(l)).length === 1;
    if (!ok) {
      console.error(
        'o índice de ADRs de docs/README.md não bate com docs/adr; rode `node build/indice-de-adrs.mjs --escrever` e o prettier',
      );
      process.exit(1);
    }
    console.log('índice de ADRs em dia');
  }
}
