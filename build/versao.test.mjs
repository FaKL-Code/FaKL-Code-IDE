import { describe, expect, it } from 'vitest';

import { montarManifestos } from './manifestos-update.mjs';
import { lerTag, releaseVersion, tagDaRelease, versaoDoApp, versaoDoProduto } from './versao.mjs';

// Mesma conta do semver.compareBuild que o patch do VSCodium faz sobre as versões
// normalizadas (sem o quarto número e sem zeros à esquerda).
const normalizada = (release) => versaoDoApp(versaoDoProduto(release));
const partes = (versao) => versao.split('.').map(Number);
const maior = (a, b) => {
  const [x, y] = [partes(normalizada(a)), partes(normalizada(b))];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

describe('versão interna', () => {
  it('só aceita tags vX.Y.Z com números pequenos', () => {
    expect(lerTag('v0.1.1')).toEqual({ major: 0, minor: 1, patch: 1 });
    for (const ruim of ['0.1.1', 'v0.1', 'v0.1.1-rc1', 'v0.100.0', 'v100.0.0', 'v1.2.3.4']) {
      expect(lerTag(ruim), ruim).toBeUndefined();
    }
  });

  it('deriva o RELEASE_VERSION da tag em cima da tag do Code-OSS', () => {
    expect(releaseVersion('v0.1.0', '1.135.0')).toBe('1.135.00100');
    expect(releaseVersion('v0.1.1', '1.135.0')).toBe('1.135.00101');
    expect(releaseVersion('v0.99.99', '1.135.0')).toBe('1.135.09999');
    expect(releaseVersion('v0.1.18', '1.143.1')).toBe('1.143.10118');
    expect(() => releaseVersion('v0.1.1-rc1', '1.135.0')).toThrow(/inválida/);
    expect(() => releaseVersion('v1.0.0', '1.135.0')).toThrow(/não cabe/);
    expect(() => releaseVersion('v0.1.1', '1.135.6')).toThrow(/Code-OSS/);
  });

  it('passa na regra do VSCodium para um RELEASE_VERSION definido de fora', () => {
    const regra = /^([0-9]+\.[0-9]+\.[0-5])[0-9]+$/;
    for (const tag of ['v0.1.0', 'v0.9.9', 'v0.99.99']) {
      const achado = regra.exec(releaseVersion(tag, '1.135.0'));
      expect(achado?.[1], tag).toBe('1.135.0');
    }
    expect(regra.exec(releaseVersion('v0.1.18', '1.143.1'))?.[1]).toBe('1.143.1');
  });

  it('cabe nos 65535 que o Windows aceita em cada parte da versão do instalador', () => {
    // Foi o que derrubou a v0.1.18 no Windows: com o Code-OSS 1.143.1 o terceiro número
    // saía 1000118 (seis dígitos depois do patch).
    for (const patch of [0, 1, 2, 3, 4, 5]) {
      for (const tag of ['v0.0.1', 'v0.1.18', 'v0.99.99']) {
        const terceiro = Number(releaseVersion(tag, `1.143.${patch}`).split('.')[2]);
        expect(terceiro, `${tag} com patch ${patch}`).toBeLessThanOrEqual(65_535);
      }
    }
  });

  it('cresce a cada versão, também entre Code-OSS diferentes', () => {
    const ordem = [
      releaseVersion('v0.1.0', '1.135.0'),
      releaseVersion('v0.1.1', '1.135.0'),
      releaseVersion('v0.2.0', '1.135.0'),
      releaseVersion('v0.99.99', '1.135.0'),
      releaseVersion('v0.0.1', '1.136.0'),
    ];
    // O caminho real de quem está na v0.1.17 (Code-OSS 1.140.0, seis dígitos) para a v0.1.18.
    expect(maior('1.143.10118', '1.140.0000117')).toBe(true);
    // Uma release no mesmo Code-OSS, e depois num patch novo dele.
    expect(maior('1.143.10119', '1.143.10118')).toBe(true);
    expect(maior(releaseVersion('v0.1.19', '1.143.2'), releaseVersion('v0.1.18', '1.143.1'))).toBe(
      true,
    );
    for (let i = 1; i < ordem.length; i++) {
      expect(maior(ordem[i], ordem[i - 1]), `${ordem[i]} > ${ordem[i - 1]}`).toBe(true);
    }
  });

  it('escreve a versão do produto como o transformVersion do VSCodium', () => {
    expect(versaoDoProduto('1.135.0000101')).toBe('1.135.101.0');
    expect(versaoDoProduto('1.135.00101')).toBe('1.135.101.0');
    expect(versaoDoProduto('1.143.10118')).toBe('1.143.10118.0');
    expect(versaoDoApp('1.135.101.0')).toBe('1.135.101');
  });

  it('volta da versão do build para a tag', () => {
    for (const tag of ['v0.1.0', 'v0.1.1', 'v0.12.34', 'v0.99.99']) {
      expect(tagDaRelease(releaseVersion(tag, '1.135.0'))).toBe(tag);
      expect(tagDaRelease(releaseVersion(tag, '1.143.1'))).toBe(tag);
    }
  });

  it('ainda lê as releases até a v0.1.17, com seis dígitos', () => {
    expect(tagDaRelease('1.140.0000117')).toBe('v0.1.17');
    expect(tagDaRelease('1.135.0000101')).toBe('v0.1.1');
  });

  it('o que não tem quatro nem seis dígitos depois do patch não é uma release nossa', () => {
    expect(tagDaRelease('1.135.0696')).toBeUndefined();
    expect(tagDaRelease('1.135.069600')).toBeUndefined();
    expect(tagDaRelease('1.135')).toBeUndefined();
  });

  it('a versão da data do build pode parecer uma tag, por isso se compara com a pedida', () => {
    // `06960` (dia do ano vezes 24 mais a hora) tem o mesmo formato do nosso contador.
    expect(tagDaRelease('1.135.06960')).toBe('v0.69.60');
    expect(tagDaRelease('1.135.06960')).not.toBe('v0.1.18');
  });
});

describe('manifestos de atualização', () => {
  const release = releaseVersion('v0.1.1', '1.135.0');
  const arquivo = (nome) => ({ nome, sha1: `sha1-${nome}`, sha256: `sha256-${nome}` });
  const arquivos = [
    arquivo(`FaKL-CodeUserSetup-x64-${release}.exe`),
    arquivo(`FaKL-CodeSetup-x64-${release}.exe`),
    arquivo(`FaKL-Code-win32-x64-${release}.zip`),
    arquivo(`FaKL-Code-darwin-arm64-${release}.zip`),
    arquivo('FaKL-Code-Windows-x64.exe'),
    arquivo('FaKL-Code-macOS-arm64.zip'),
  ];
  const montar = (lista = arquivos, tag = 'v0.1.1') =>
    montarManifestos({
      tag,
      repositorio: 'FaKL-Code/FaKL-Code-IDE',
      release,
      arquivos: lista,
      agora: 1_000,
    });

  it('gera um manifesto por alvo do Windows, no formato do VS Code', () => {
    const saida = montar();
    expect(Object.keys(saida).sort()).toEqual([
      'latest.json',
      'stable/win32/x64/archive/latest.json',
      'stable/win32/x64/system/latest.json',
      'stable/win32/x64/user/latest.json',
    ]);
    expect(saida['stable/win32/x64/user/latest.json']).toEqual({
      url: `https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.1/FaKL-CodeUserSetup-x64-${release}.exe`,
      name: '0.1.1',
      version: expect.stringMatching(/^[0-9a-f]{40}$/),
      productVersion: '1.135.101.0',
      hash: `sha1-FaKL-CodeUserSetup-x64-${release}.exe`,
      timestamp: 1_000,
      sha256hash: `sha256-FaKL-CodeUserSetup-x64-${release}.exe`,
    });
  });

  it('não publica manifesto nativo para o macOS, só o aviso', () => {
    const saida = montar();
    expect(Object.keys(saida).some((caminho) => caminho.includes('darwin'))).toBe(false);
    expect(saida['latest.json']).toMatchObject({
      tag: 'v0.1.1',
      name: '0.1.1',
      page: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/tag/v0.1.1',
    });
    expect(saida['latest.json'].platforms['darwin-arm64'].url).toContain(
      `FaKL-Code-darwin-arm64-${release}.zip`,
    );
  });

  it('gera o manifesto do Linux a partir do tar.gz e o inclui no aviso', () => {
    const linux = arquivo(`FaKL-Code-linux-x64-${release}.tar.gz`);
    const saida = montar([linux, arquivo('FaKL-Code-Linux-x64.tar.gz'), arquivo('fakl-code.deb')]);
    expect(Object.keys(saida).sort()).toEqual(['latest.json', 'stable/linux/x64/latest.json']);
    expect(saida['stable/linux/x64/latest.json'].url).toContain(
      `/download/v0.1.1/FaKL-Code-linux-x64-${release}.tar.gz`,
    );
    expect(saida['latest.json'].platforms['linux-x64'].url).toContain('.tar.gz');
  });

  it('não usa as cópias de nome fixo', () => {
    const saida = JSON.stringify(montar());
    expect(saida).not.toContain('FaKL-Code-Windows-x64.exe');
    expect(saida).not.toContain('FaKL-Code-macOS-arm64.zip');
  });

  it('omite o alvo cujo instalador não veio e devolve vazio sem nenhum', () => {
    const sem = montar(arquivos.filter((a) => !a.nome.includes('Setup-x64')));
    expect(Object.keys(sem).sort()).toEqual([
      'latest.json',
      'stable/win32/x64/archive/latest.json',
    ]);
    expect(montar([])).toEqual({});
  });

  it('recusa tag que não gerou o RELEASE_VERSION e instalador duplicado', () => {
    expect(() => montar(arquivos, 'v0.1.2')).toThrow(/não vem da tag/);
    expect(() => montar([...arquivos, arquivo(`Outro-win32-x64-${release}.zip`)])).toThrow(
      /mais de um/,
    );
  });
});
