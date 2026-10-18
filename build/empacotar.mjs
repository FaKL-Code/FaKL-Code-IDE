#!/usr/bin/env node
// Gera os manifestos dos gerenciadores de pacote a partir de uma release (ADR 0046):
// winget (microsoft/winget-pkgs), Scoop (bucket próprio) e Homebrew (tap próprio).
//
// Uso: node build/empacotar.mjs vX.Y.Z <pasta-de-saida> [--repo dono/nome]
// Lê o SHA256SUMS.txt da release no GitHub e escreve:
//   <saida>/winget/manifests/f/FaKLCode/FaKLCode/<versao>/*.yaml
//   <saida>/scoop/bucket/fakl-code.json
//   <saida>/homebrew/Casks/fakl-code.rb

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseVersion } from './versao.mjs';

const REPO_PADRAO = 'FaKL-Code/FaKL-Code-IDE';
/** ProductCode do instalador por usuário (Inno Setup: AppId com `_is1`). */
export const PRODUCT_CODE_USUARIO = '{7E35198C-0D07-4AA7-905F-5F53506E3F09}_is1';
const ESQUEMA_WINGET = '1.9.0';

/** `{ arquivo: sha256 }` a partir do texto do SHA256SUMS.txt. */
export function lerSomas(texto) {
  const somas = {};
  for (const linha of texto.split(/\r?\n/)) {
    const achado = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(linha);
    if (achado) somas[achado[2]] = achado[1].toLowerCase();
  }
  return somas;
}

function exigir(somas, arquivo) {
  const soma = somas[arquivo];
  if (!soma) throw new Error(`o SHA256SUMS.txt não lista ${arquivo}`);
  return soma;
}

/** Os três arquivos de manifesto do winget (versão, instalador e idiomas), 1.9.0. */
export function manifestosWinget({ tag, repo, release, somas }) {
  const versao = tag.slice(1);
  const instalador = `FaKL-CodeUserSetup-x64-${release}.exe`;
  const sha = exigir(somas, instalador).toUpperCase();
  const base = `https://github.com/${repo}`;
  const id = 'FaKLCode.FaKLCode';
  const cabecalho = (tipo) =>
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${tipo}.${ESQUEMA_WINGET}.schema.json\n`;
  const comum = `PackageIdentifier: ${id}\nPackageVersion: ${versao}\n`;
  return {
    [`${id}.yaml`]: `${cabecalho('version')}${comum}DefaultLocale: en-US\nManifestType: version\nManifestVersion: ${ESQUEMA_WINGET}\n`,
    [`${id}.installer.yaml`]:
      `${cabecalho('installer')}${comum}` +
      `InstallerType: inno\nScope: user\nInstallModes:\n  - interactive\n  - silent\n  - silentWithProgress\n` +
      `UpgradeBehavior: install\nReleaseDate: ${new Date().toISOString().slice(0, 10)}\n` +
      `Installers:\n  - Architecture: x64\n    InstallerUrl: ${base}/releases/download/${tag}/${instalador}\n` +
      `    InstallerSha256: ${sha}\n    ProductCode: '${PRODUCT_CODE_USUARIO}'\n` +
      `    AppsAndFeaturesEntries:\n      - DisplayName: FaKL-Code (User)\n        Publisher: FaKL-Code\n` +
      `        DisplayVersion: ${release}\n        ProductCode: '${PRODUCT_CODE_USUARIO}'\n` +
      `ManifestType: installer\nManifestVersion: ${ESQUEMA_WINGET}\n`,
    [`${id}.locale.en-US.yaml`]:
      `${cabecalho('defaultLocale')}${comum}PackageLocale: en-US\nPublisher: FaKL-Code\n` +
      `PublisherUrl: https://github.com/FaKL-Code\nPublisherSupportUrl: ${base}/issues\n` +
      `PackageName: FaKL-Code IDE\nPackageUrl: ${base}\nLicense: AGPL-3.0-only\n` +
      `LicenseUrl: ${base}/blob/main/LICENSE\nShortDescription: Open source IDE for AI-assisted development, a VSCodium fork.\n` +
      `Description: >-\n  FaKL-Code is an open source fork of VSCodium for AI-assisted development. It orchestrates\n` +
      `  Claude Code, Codex, Gemini and local models with one worktree per agent, a Markdown vault\n` +
      `  for memory, GitHub, SSH and phone control through a self-hosted relay. No account required.\n` +
      `Moniker: fakl-code\nTags:\n  - ai\n  - agents\n  - ide\n  - vscode\n  - vscodium\n  - open-source\n` +
      `ReleaseNotesUrl: ${base}/releases/tag/${tag}\nManifestType: defaultLocale\nManifestVersion: ${ESQUEMA_WINGET}\n`,
    [`${id}.locale.pt-BR.yaml`]:
      `${cabecalho('locale')}${comum}PackageLocale: pt-BR\nPublisher: FaKL-Code\n` +
      `PublisherUrl: https://github.com/FaKL-Code\nPublisherSupportUrl: ${base}/issues\n` +
      `PackageName: FaKL-Code IDE\nPackageUrl: ${base}\nLicense: AGPL-3.0-only\n` +
      `LicenseUrl: ${base}/blob/main/LICENSE\nShortDescription: IDE open source para desenvolvimento assistido por IA, um fork do VSCodium.\n` +
      `ManifestType: locale\nManifestVersion: ${ESQUEMA_WINGET}\n`,
  };
}

/** Manifesto do Scoop: usa o instalador de nome fixo, que o Inno extrai (`innosetup`). */
export function manifestoScoop({ tag, repo, somas }) {
  const versao = tag.slice(1);
  const arquivo = 'FaKL-Code-Windows-x64.exe';
  const base = `https://github.com/${repo}`;
  return `${JSON.stringify(
    {
      version: versao,
      description: 'IDE open source para desenvolvimento assistido por IA, um fork do VSCodium.',
      homepage: base,
      license: 'AGPL-3.0-only',
      notes:
        'O instalador do Windows não é assinado. Esta instalação é portátil: o auto-update da IDE só avisa; atualize com `scoop update fakl-code`.',
      architecture: {
        '64bit': {
          url: `${base}/releases/download/${tag}/${arquivo}`,
          hash: exigir(somas, arquivo),
        },
      },
      innosetup: true,
      bin: [['FaKL-Code.exe', 'fakl-code']],
      shortcuts: [['FaKL-Code.exe', 'FaKL-Code IDE']],
      checkver: {
        url: `https://api.github.com/repos/${repo}/releases`,
        jsonpath: '$[0].tag_name',
        regex: 'v([\\d.]+)',
      },
      autoupdate: {
        architecture: {
          '64bit': { url: `${base}/releases/download/v$version/${arquivo}` },
        },
        hash: {
          url: `${base}/releases/download/v$version/SHA256SUMS.txt`,
          regex: `$sha256\\s+${arquivo}`,
        },
      },
    },
    null,
    4,
  )}\n`;
}

/** Cask do Homebrew para o `.zip` de nome fixo do macOS (Apple Silicon, sem notarização). */
export function caskHomebrew({ tag, repo, somas }) {
  const versao = tag.slice(1);
  const arquivo = 'FaKL-Code-macOS-arm64.zip';
  const base = `https://github.com/${repo}`;
  return `cask "fakl-code" do
  version "${versao}"
  sha256 "${exigir(somas, arquivo)}"

  url "${base}/releases/download/v#{version}/${arquivo}"
  name "FaKL-Code IDE"
  desc "Open source IDE for AI-assisted development, a VSCodium fork"
  homepage "${base}"

  livecheck do
    url "${base}/releases"
    strategy :github_releases
  end

  depends_on arch: :arm64

  app "FaKL-Code IDE.app"

  # O app tem assinatura ad hoc e não é notarizado: tira a quarentena para o Gatekeeper
  # não bloquear a primeira abertura. Remova esta linha quando houver notarização.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/FaKL-Code IDE.app"],
                   sudo: false
  end

  zap trash: [
    "~/.fakl",
    "~/.fakl-code",
    "~/Library/Application Support/FaKL-Code",
  ]
end
`;
}

async function principal() {
  const [tag, saida, ...resto] = process.argv.slice(2);
  if (!tag || !saida) {
    console.error('uso: empacotar.mjs vX.Y.Z <saida> [--repo dono/nome]');
    process.exit(2);
  }
  const indice = resto.indexOf('--repo');
  const repo = indice >= 0 ? resto[indice + 1] : REPO_PADRAO;
  const stable = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../upstream/stable.json'), 'utf8'),
  );
  const release = releaseVersion(tag, stable.tag);
  const resposta = await fetch(
    `https://github.com/${repo}/releases/download/${tag}/SHA256SUMS.txt`,
  );
  if (!resposta.ok) throw new Error(`SHA256SUMS.txt da ${tag}: HTTP ${resposta.status}`);
  const somas = lerSomas(await resposta.text());
  const escrever = (caminho, texto) => {
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, texto);
    console.log(caminho);
  };
  const pastaWinget = join(saida, 'winget', 'manifests', 'f', 'FaKLCode', 'FaKLCode', tag.slice(1));
  for (const [nome, texto] of Object.entries(manifestosWinget({ tag, repo, release, somas }))) {
    escrever(join(pastaWinget, nome), texto);
  }
  escrever(join(saida, 'scoop', 'bucket', 'fakl-code.json'), manifestoScoop({ tag, repo, somas }));
  escrever(join(saida, 'homebrew', 'Casks', 'fakl-code.rb'), caskHomebrew({ tag, repo, somas }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  principal().catch((erro) => {
    console.error(erro.message);
    process.exit(1);
  });
}
