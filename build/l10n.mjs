#!/usr/bin/env node
// Confere a tradução da interface (pacote @fakl/i18n):
// - todo `l10n.t('...')` / `vscode.l10n.t('...')` do código tem texto pt-BR
//   em packages/i18n/src/catalogos/pt-br/*.json;
// - nenhum catálogo guarda texto que o código não usa mais;
// - a mesma chave não tem dois textos em catálogos diferentes;
// - os placeholders ({0}, {nome}) do texto pt-BR são os mesmos do inglês;
// - cada %chave% dos package.json das extensões existe em package.nls.json
//   (inglês) e em package.nls.pt-br.json, e nenhum dos dois sobra.
//
// Uso: node build/l10n.mjs           confere e sai com 1 se algo falta
//      node build/l10n.mjs --faltando imprime, em JSON, as chaves sem tradução

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getL10nJson } from '@vscode/l10n-dev';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGOS = join(ROOT, 'packages', 'i18n', 'src', 'catalogos', 'pt-br');
const FONTES = ['extensions', 'apps', 'packages'];
const IGNORAR = new Set(['node_modules', 'dist', 'out', 'test', 'bundle', 'coverage']);

function* arquivos(pasta) {
  for (const nome of readdirSync(pasta)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) yield* arquivos(caminho);
    else if (/\.tsx?$/.test(nome) && !nome.endsWith('.d.ts')) yield caminho;
  }
}

/** Pastas src/ dos pacotes, apps e extensões (o próprio @fakl/i18n fica de fora). */
function pastasDeCodigo() {
  const pastas = [];
  for (const grupo of FONTES) {
    for (const nome of readdirSync(join(ROOT, grupo))) {
      const src = join(ROOT, grupo, nome, 'src');
      if (grupo === 'packages' && nome === 'i18n') continue;
      try {
        if (statSync(src).isDirectory()) pastas.push(src);
      } catch {
        // pacote sem src/
      }
    }
  }
  return pastas;
}

export function placeholders(texto) {
  return [...texto.matchAll(/\{([^{}\s]+)\}/g)].map((m) => m[1]).sort();
}

async function chavesDoCodigo() {
  /** chave → primeiro arquivo onde aparece */
  const chaves = new Map();
  for (const pasta of pastasDeCodigo()) {
    for (const arquivo of arquivos(pasta)) {
      const original = readFileSync(arquivo, 'utf8');
      if (!original.includes('l10n.t')) continue;
      // O extrator só reconhece o `l10n` importado de 'vscode' ou '@vscode/l10n';
      // o do @fakl/i18n é o mesmo objeto, reexportado.
      const contents = original.replaceAll("from '@fakl/i18n'", "from '@vscode/l10n'");
      const json = await getL10nJson([{ extension: '.ts', contents }]);
      for (const chave of Object.keys(json)) {
        if (!chaves.has(chave)) chaves.set(chave, relative(ROOT, arquivo).replaceAll('\\', '/'));
      }
    }
  }
  return chaves;
}

function catalogos() {
  const problemas = [];
  const juntos = new Map();
  for (const nome of readdirSync(CATALOGOS)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const dados = JSON.parse(readFileSync(join(CATALOGOS, nome), 'utf8'));
    for (const [chave, texto] of Object.entries(dados)) {
      const anterior = juntos.get(chave);
      if (anterior && anterior.texto !== texto) {
        problemas.push(`"${chave}" tem textos diferentes em ${anterior.arquivo} e ${nome}`);
      }
      juntos.set(chave, { texto, arquivo: nome });
    }
  }
  return { juntos, problemas };
}

function nlsDasExtensoes() {
  const problemas = [];
  for (const nome of readdirSync(join(ROOT, 'extensions'))) {
    const pasta = join(ROOT, 'extensions', nome);
    let manifesto;
    try {
      manifesto = readFileSync(join(pasta, 'package.json'), 'utf8');
    } catch {
      continue;
    }
    const usadas = new Set([...manifesto.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
    if (usadas.size === 0) continue;
    for (const arquivo of ['package.nls.json', 'package.nls.pt-br.json']) {
      let nls;
      try {
        nls = JSON.parse(readFileSync(join(pasta, arquivo), 'utf8'));
      } catch {
        problemas.push(`extensions/${nome}/${arquivo} não existe`);
        continue;
      }
      for (const chave of usadas) {
        if (!(chave in nls)) problemas.push(`extensions/${nome}/${arquivo}: falta %${chave}%`);
      }
      for (const chave of Object.keys(nls)) {
        if (!usadas.has(chave)) problemas.push(`extensions/${nome}/${arquivo}: sobra ${chave}`);
      }
    }
    const en = JSON.parse(readFileSync(join(pasta, 'package.nls.json'), 'utf8'));
    let pt = {};
    try {
      pt = JSON.parse(readFileSync(join(pasta, 'package.nls.pt-br.json'), 'utf8'));
    } catch {
      // já informado acima
    }
    for (const [chave, texto] of Object.entries(pt)) {
      if (
        typeof en[chave] === 'string' &&
        placeholders(en[chave]).join() !== placeholders(texto).join()
      ) {
        problemas.push(
          `extensions/${nome}/package.nls.pt-br.json: placeholders de ${chave} não batem`,
        );
      }
    }
  }
  return problemas;
}

async function main(argv) {
  const codigo = await chavesDoCodigo();
  const { juntos, problemas } = catalogos();
  const faltando = [...codigo].filter(([chave]) => !juntos.has(chave));
  if (argv.includes('--faltando')) {
    console.log(JSON.stringify(Object.fromEntries(faltando), null, 2));
    return 0;
  }
  for (const [chave, arquivo] of faltando) {
    problemas.push(`${arquivo}: sem tradução pt-BR para "${chave}"`);
  }
  for (const [chave, { arquivo }] of juntos) {
    if (!codigo.has(chave)) problemas.push(`${arquivo}: "${chave}" não é usado no código`);
  }
  for (const [chave, { texto, arquivo }] of juntos) {
    if (placeholders(chave).join() !== placeholders(texto).join()) {
      problemas.push(`${arquivo}: placeholders de "${chave}" não batem com a tradução`);
    }
  }
  problemas.push(...nlsDasExtensoes());
  if (problemas.length) {
    console.error(`Tradução incompleta (${problemas.length}):`);
    for (const problema of problemas) console.error(`  ${problema}`);
    console.error(
      'Dica: node build/l10n.mjs --faltando lista as chaves que precisam de texto pt-BR.',
    );
    return 1;
  }
  console.log(`Tradução completa: ${codigo.size} textos com pt-BR.`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
