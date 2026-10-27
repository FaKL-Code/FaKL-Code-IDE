#!/usr/bin/env node
// Versão interna da IDE a partir da tag da release.
//
// O VS Code compara a versão do app com a do manifesto de atualização (ADR 0037).
// Os scripts do VSCodium montam essa versão com a data do build (dia do ano e hora),
// que volta ao começo todo ano e não diz nada sobre a release. Aqui ela sai da tag:
// vX.Y.Z vira `<Code-OSS>` + X*10000 + Y*100 + Z, com quatro dígitos. O VSCodium aceita
// um RELEASE_VERSION já definido desde que comece pela tag do Code-OSS.
//
//   v0.1.1  + Code-OSS 1.135.0  ->  1.135.00101  (o app mostra 1.135.101)
//   v0.1.18 + Code-OSS 1.143.1  ->  1.143.10118  (o app mostra 1.143.10118)
//
// O terceiro número é o dígito de patch do Code-OSS seguido dos quatro do contador, e o
// Windows aceita no máximo 65535 em cada parte da versão do instalador (ADR 0054). Até a
// v0.1.17 eram seis dígitos, que só cabiam com o patch do Code-OSS em 0.
//
// Uso: node build/versao.mjs v0.1.1   (imprime o RELEASE_VERSION)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** `{ major, minor, patch }` de uma tag vX.Y.Z, ou `undefined` se ela tem outro formato. */
export function lerTag(tag) {
  const achado = TAG.exec(tag);
  if (!achado) return undefined;
  const [major, minor, patch] = achado.slice(1).map(Number);
  if (minor > 99 || patch > 99 || major > 99) return undefined;
  return { major, minor, patch };
}

/** Número que cresce com a versão: 0.1.0 = 100, 0.1.1 = 101, 1.0.0 = 10000. */
export function numeroDaVersao({ major, minor, patch }) {
  return major * 10_000 + minor * 100 + patch;
}

/** Maior contador que cabe: com patch 5 do Code-OSS, 5*10000 + 9999 = 59999 < 65535. */
export const LIMITE_DO_CONTADOR = 9_999;

/** RELEASE_VERSION do VSCodium para a tag, em cima da tag do Code-OSS (ex. "1.135.0"). */
export function releaseVersion(tag, codeOssTag) {
  const versao = lerTag(tag);
  if (!versao) throw new Error(`tag inválida: ${tag} (use vX.Y.Z)`);
  if (!/^\d+\.\d+\.[0-5]$/.test(codeOssTag)) {
    throw new Error(`tag do Code-OSS inesperada: ${codeOssTag}`);
  }
  const numero = numeroDaVersao(versao);
  if (numero > LIMITE_DO_CONTADOR) {
    throw new Error(
      `a tag ${tag} não cabe na versão do instalador do Windows (contador ${numero}, máximo ${LIMITE_DO_CONTADOR}): veja a ADR 0054`,
    );
  }
  return `${codeOssTag}${String(numero).padStart(4, '0')}`;
}

/**
 * Versão do produto como o manifesto de atualização a guarda: o terceiro número sem
 * zeros à esquerda e um quarto número zero (o `transformVersion` do VSCodium).
 */
export function versaoDoProduto(release) {
  const partes = release.split('.');
  if (partes.length !== 3) throw new Error(`RELEASE_VERSION inesperado: ${release}`);
  return `${partes[0]}.${partes[1]}.${Number.parseInt(partes[2], 10)}.0`;
}

/** Versão que o app mostra e compara (sem o quarto número), a partir da do manifesto. */
export function versaoDoApp(produto) {
  return produto.replace(/^(\d+\.\d+\.\d+)\.\d+$/, '$1');
}

/** A tag vX.Y.Z que originou um RELEASE_VERSION feito por `releaseVersion`. */
export function tagDaRelease(release) {
  // O primeiro dígito do terceiro número é o patch do Code-OSS; o resto, o da release:
  // quatro dígitos, ou seis nas releases até a v0.1.17. A versão da data do build também
  // tem quatro (`06960`), então quem usa isto compara o resultado com a tag que pediu.
  const digitos = (release.split('.')[2] ?? '').slice(1);
  if (!/^(\d{4}|\d{6})$/.test(digitos)) return undefined;
  const terceiro = Number.parseInt(digitos, 10);
  const major = Math.floor(terceiro / 10_000);
  const minor = Math.floor((terceiro % 10_000) / 100);
  return `v${major}.${minor}.${terceiro % 100}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  const stable = JSON.parse(
    readFileSync(new URL('../upstream/stable.json', import.meta.url), 'utf8'),
  );
  try {
    process.stdout.write(`${releaseVersion(tag ?? '', stable.tag)}\n`);
  } catch (erro) {
    process.stderr.write(`${erro.message}\n`);
    process.exit(1);
  }
}
