import { describe, expect, it } from 'vitest';

import {
  caskHomebrew,
  lerSomas,
  manifestoScoop,
  manifestosWinget,
  PRODUCT_CODE_USUARIO,
} from './empacotar.mjs';
import { releaseVersion } from './versao.mjs';

const tag = 'v0.1.5';
const repo = 'FaKL-Code/FaKL-Code-IDE';
const release = releaseVersion(tag, '1.135.0');
const hex = (c) => c.repeat(64);
const somas = lerSomas(
  [
    `${hex('a')}  FaKL-CodeUserSetup-x64-${release}.exe`,
    `${hex('B')} *FaKL-Code-Windows-x64.exe`,
    `${hex('c')}  FaKL-Code-macOS-arm64.zip`,
    'linha estranha',
  ].join('\r\n'),
);

describe('empacotamento', () => {
  it('lê o SHA256SUMS.txt, com ou sem asterisco e em qualquer caixa', () => {
    expect(somas[`FaKL-CodeUserSetup-x64-${release}.exe`]).toBe(hex('a'));
    expect(somas['FaKL-Code-Windows-x64.exe']).toBe(hex('b'));
    expect(Object.keys(somas)).toHaveLength(3);
  });

  it('gera os quatro arquivos do winget com a URL e o hash do instalador por usuário', () => {
    const arquivos = manifestosWinget({ tag, repo, release, somas });
    expect(Object.keys(arquivos).sort()).toEqual([
      'FaKLCode.FaKLCode.installer.yaml',
      'FaKLCode.FaKLCode.locale.en-US.yaml',
      'FaKLCode.FaKLCode.locale.pt-BR.yaml',
      'FaKLCode.FaKLCode.yaml',
    ]);
    const instalador = arquivos['FaKLCode.FaKLCode.installer.yaml'];
    expect(instalador).toContain(
      `https://github.com/${repo}/releases/download/${tag}/FaKL-CodeUserSetup-x64-${release}.exe`,
    );
    expect(instalador).toContain(`InstallerSha256: ${hex('a').toUpperCase()}`);
    expect(instalador).toContain(PRODUCT_CODE_USUARIO);
    expect(instalador).toContain(`DisplayVersion: ${release}`);
    for (const texto of Object.values(arquivos)) expect(texto).toContain('PackageVersion: 0.1.5');
  });

  it('gera o manifesto do Scoop com o instalador de nome fixo e a regra de atualização', () => {
    const manifesto = JSON.parse(manifestoScoop({ tag, repo, somas }));
    expect(manifesto.version).toBe('0.1.5');
    expect(manifesto.architecture['64bit'].hash).toBe(hex('b'));
    expect(manifesto.architecture['64bit'].url).toContain('/v0.1.5/FaKL-Code-Windows-x64.exe');
    expect(manifesto.innosetup).toBe(true);
    expect(manifesto.autoupdate.architecture['64bit'].url).toContain('v$version');
    expect(manifesto.checkver.jsonpath).toBe('$[0].tag_name');
  });

  it('gera o cask do Homebrew para Apple Silicon e tira a quarentena', () => {
    const cask = caskHomebrew({ tag, repo, somas });
    expect(cask).toContain('version "0.1.5"');
    expect(cask).toContain(`sha256 "${hex('c')}"`);
    expect(cask).toContain('depends_on arch: :arm64');
    expect(cask).toContain('com.apple.quarantine');
  });

  it('recusa release cujo SHA256SUMS.txt não lista o instalador', () => {
    expect(() => manifestosWinget({ tag, repo, release, somas: {} })).toThrow(/não lista/);
    expect(() => manifestoScoop({ tag, repo, somas: {} })).toThrow(/não lista/);
    expect(() => caskHomebrew({ tag, repo, somas: {} })).toThrow(/não lista/);
  });
});
