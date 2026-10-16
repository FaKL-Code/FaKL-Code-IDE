#!/usr/bin/env node
// Procura, nos arquivos do repositório, termos que não podem ir a público:
// nomes, emails, IPs, máquinas e caminhos pessoais do mantenedor. A lista
// (build/termos-proibidos.sha256) guarda só o SHA-256 de cada termo, para que
// os próprios termos não fiquem expostos nela.
//
// Um termo casa com uma palavra inteira ou com uma sequência de partes de uma
// palavra: "c:/src" casa com "C:\src\x" mas não com "C:\srcx"; "meu-pc" casa com
// "meu-pc-2". Tudo é comparado em minúsculas e com "\" trocado por "/".
//
// Uso:
//   node build/termos-proibidos.mjs [arquivos...]   confere os arquivos dados ou,
//                                                   sem eles, os versionados e os novos
//   node build/termos-proibidos.mjs --commits A..B  confere também os emails de
//                                                   autor e committer dos commits
//   node build/termos-proibidos.mjs --hash "termo"  imprime a linha para a lista

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTA = join(ROOT, 'build', 'termos-proibidos.sha256');

/** Caminhos que a checagem não lê. Vazio: nada fica fora da lista de termos. */
const IGNORADOS = [];

/** Partes de uma palavra que um termo pode juntar; mais que isso não é termo. */
const MAX_PARTES = 8;

export function normalizar(texto) {
  return texto.toLowerCase().replaceAll('\\', '/');
}

export function hash(termo) {
  return createHash('sha256').update(normalizar(termo).trim()).digest('hex');
}

/** Palavras do texto e todas as sequências contíguas das partes de cada uma. */
export function* candidatos(texto) {
  for (const [palavra] of normalizar(texto).matchAll(/[\p{L}\p{N}._@:/-]+/gu)) {
    // [parte, separador, parte, separador, parte...]
    const pedacos = palavra.split(/([._@:/-]+)/);
    for (let i = 0; i < pedacos.length; i += 2) {
      if (!pedacos[i]) continue;
      let atual = pedacos[i];
      yield atual;
      for (let j = i + 2; j < pedacos.length && j <= i + 2 * MAX_PARTES; j += 2) {
        atual += pedacos[j - 1] + pedacos[j];
        if (pedacos[j]) yield atual;
      }
    }
  }
}

export function lerLista(texto) {
  return new Set(
    texto
      .split('\n')
      .map((linha) => linha.replace(/#.*/, '').trim())
      .filter(Boolean),
  );
}

/** Ocorrências de termos proibidos num texto, com a linha de cada uma. */
export function procurar(texto, proibidos, cache = new Map()) {
  const achados = [];
  texto.split('\n').forEach((linha, indice) => {
    for (const candidato of candidatos(linha)) {
      let proibido = cache.get(candidato);
      if (proibido === undefined) {
        proibido = proibidos.has(hash(candidato));
        cache.set(candidato, proibido);
      }
      if (proibido) achados.push({ linha: indice + 1, termo: candidato });
    }
  });
  return achados;
}

/** Só as duas primeiras letras: o log do CI não deve repetir o termo inteiro. */
export function mascarar(termo) {
  return `${termo.slice(0, 2)}${'•'.repeat(Math.max(termo.length - 2, 3))}`;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(argv) {
  const hashAt = argv.indexOf('--hash');
  if (hashAt !== -1) {
    const termo = argv[hashAt + 1];
    if (!termo) throw new Error('--hash precisa do termo');
    console.log(`${hash(termo)}  # descreva a categoria, nunca o termo`);
    return 0;
  }

  const proibidos = lerLista(readFileSync(LISTA, 'utf8'));
  const cache = new Map();
  const problemas = [];

  let faixa;
  const arquivosDados = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commits') {
      faixa = argv[++i];
      if (!faixa) throw new Error('--commits precisa de uma faixa, por exemplo origin/main..HEAD');
    } else {
      arquivosDados.push(argv[i]);
    }
  }

  const arquivos = arquivosDados.length
    ? arquivosDados
    : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean);
  for (const arquivo of arquivos) {
    const relativo = arquivo.replaceAll('\\', '/');
    if (IGNORADOS.some((prefixo) => relativo.startsWith(prefixo))) continue;
    let conteudo;
    try {
      conteudo = readFileSync(join(ROOT, relativo));
    } catch {
      continue; // apagado no worktree
    }
    if (conteudo.subarray(0, 8000).includes(0)) continue; // binário
    for (const termo of procurar(relativo, proibidos, cache)) {
      problemas.push(`${relativo}: nome do arquivo contém ${mascarar(termo.termo)}`);
    }
    for (const achado of procurar(conteudo.toString('utf8'), proibidos, cache)) {
      problemas.push(`${relativo}:${achado.linha}: ${mascarar(achado.termo)}`);
    }
  }

  if (faixa) {
    const linhas = git(['log', '--format=%h %ae %ce', faixa]).split('\n').filter(Boolean);
    for (const linha of linhas) {
      const [commit, ...emails] = linha.split(' ');
      for (const email of emails) {
        for (const termo of procurar(email, proibidos, cache)) {
          problemas.push(
            `commit ${commit}: email de autor ou committer contém ${mascarar(termo.termo)}`,
          );
        }
      }
    }
  }

  if (problemas.length) {
    console.error(`Termos proibidos encontrados (${problemas.length}):`);
    for (const problema of problemas) console.error(`  ${problema}`);
    console.error('Troque por um exemplo genérico (exemplo.com, 203.0.113.10, Ana Silva).');
    return 1;
  }
  console.log(
    `Nenhum termo proibido em ${arquivos.length} arquivos${faixa ? ` e nos commits ${faixa}` : ''}.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
