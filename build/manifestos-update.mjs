#!/usr/bin/env node
// Manifestos de atualização da IDE (ADR 0037).
//
// O serviço de update do VS Code, com o patch do VSCodium, lê
//   <updateUrl>/<qualidade>/<plataforma>/<arquitetura>[/<alvo>]/latest.json
// e compara `productVersion` com a versão do app. Este script gera esses arquivos a
// partir dos instaladores de uma release, para o release.yml publicá-los na branch
// `atualizacoes`, de onde o `updateUrl` do product.json os serve.
//
// Só o Windows tem atualização nativa: o updater do macOS (Squirrel.Mac) exige app
// assinado e notarizado, e o nosso sai só com assinatura ad hoc (docs/assinatura.md).
// Para o macOS o `latest.json` da raiz diz qual é a versão nova e a IDE só avisa.
//
// Uso: node build/manifestos-update.mjs <pasta-dos-instaladores> <saida> <tag> <repo>

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tagDaRelease, versaoDoProduto } from './versao.mjs';

const resumo = (conteudo, algoritmo) => createHash(algoritmo).update(conteudo).digest('hex');

/** Instaladores que entram no manifesto de cada alvo do Windows e no aviso do macOS. */
function alvos(release) {
  const termina = (extensao) => (nome) => nome.endsWith(`-${release}.${extensao}`);
  return [
    {
      caminho: 'stable/win32/x64/user/latest.json',
      plataforma: 'win32-x64',
      escolher: (nome) => termina('exe')(nome) && nome.includes('UserSetup-x64-'),
    },
    {
      caminho: 'stable/win32/x64/system/latest.json',
      escolher: (nome) =>
        termina('exe')(nome) && nome.includes('Setup-x64-') && !nome.includes('UserSetup-'),
    },
    {
      caminho: 'stable/win32/x64/archive/latest.json',
      escolher: (nome) => termina('zip')(nome) && nome.includes('-win32-x64-'),
    },
    {
      plataforma: 'darwin-arm64',
      escolher: (nome) => termina('zip')(nome) && nome.includes('-darwin-arm64-'),
    },
  ];
}

/**
 * Monta os arquivos do manifesto: `{ caminho: objeto }`. `arquivos` lista os
 * instaladores com o nome e os resumos SHA-1 e SHA-256 do conteúdo final (já assinado).
 * Falta de um instalador do Windows só omite o alvo dele; sem nenhum instalador devolve vazio.
 */
export function montarManifestos({ tag, repositorio, release, arquivos, agora }) {
  if (tagDaRelease(release) !== tag) {
    throw new Error(`o RELEASE_VERSION ${release} não vem da tag ${tag}`);
  }
  const base = `https://github.com/${repositorio}/releases`;
  const versaoApp = tag.slice(1);
  const produto = versaoDoProduto(release);
  const identificador = resumo(release, 'sha1');
  const saida = {};
  const plataformas = {};

  for (const alvo of alvos(release)) {
    const achados = arquivos.filter((arquivo) => alvo.escolher(arquivo.nome));
    if (achados.length === 0) continue;
    if (achados.length > 1) {
      throw new Error(`mais de um instalador para ${alvo.caminho ?? alvo.plataforma}`);
    }
    const [arquivo] = achados;
    const url = `${base}/download/${tag}/${arquivo.nome}`;
    if (alvo.caminho) {
      saida[alvo.caminho] = {
        url,
        name: versaoApp,
        version: identificador,
        productVersion: produto,
        hash: arquivo.sha1,
        timestamp: agora,
        sha256hash: arquivo.sha256,
      };
    }
    if (alvo.plataforma) plataformas[alvo.plataforma] = { url, sha256: arquivo.sha256 };
  }

  if (Object.keys(plataformas).length > 0) {
    saida['latest.json'] = {
      tag,
      name: versaoApp,
      productVersion: produto,
      publishedAt: agora,
      page: `${base}/tag/${tag}`,
      platforms: plataformas,
    };
  }
  return saida;
}

function main() {
  const [pasta, destino, tag, repositorio] = process.argv.slice(2);
  if (!pasta || !destino || !tag || !repositorio) {
    process.stderr.write('uso: manifestos-update.mjs <instaladores> <saida> <tag> <repo>\n');
    process.exit(2);
  }
  const stable = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../upstream/stable.json'), 'utf8'),
  );
  // O RELEASE_VERSION está no nome de todo instalador: vem do primeiro que casar.
  const nomes = readdirSync(pasta).filter((nome) => /-\d+\.\d+\.\d+\.(exe|zip)$/.test(nome));
  const release = nomes
    .map((nome) => /-(\d+\.\d+\.\d+)\.(?:exe|zip)$/.exec(nome)?.[1])
    .find((versao) => versao?.startsWith(stable.tag));
  if (!release) throw new Error(`nenhum instalador com o RELEASE_VERSION em ${pasta}`);
  const arquivos = nomes
    .filter((nome) => nome.endsWith(`-${release}.exe`) || nome.endsWith(`-${release}.zip`))
    .map((nome) => {
      const conteudo = readFileSync(join(pasta, nome));
      return { nome, sha1: resumo(conteudo, 'sha1'), sha256: resumo(conteudo, 'sha256') };
    });
  const manifestos = montarManifestos({ tag, repositorio, release, arquivos, agora: Date.now() });
  for (const [caminho, objeto] of Object.entries(manifestos)) {
    const arquivo = join(destino, caminho);
    mkdirSync(dirname(arquivo), { recursive: true });
    writeFileSync(arquivo, `${JSON.stringify(objeto, null, 2)}\n`);
    process.stdout.write(`${caminho}\n`);
  }
  if (Object.keys(manifestos).length === 0) throw new Error('nenhum manifesto gerado');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (erro) {
    process.stderr.write(`${erro.message}\n`);
    process.exit(1);
  }
}
