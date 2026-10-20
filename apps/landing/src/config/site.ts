/**
 * Tudo o que muda sem mexer nas páginas: endereço, links de download e filme.
 * Os textos em cada idioma ficam em `src/i18n`. Os instaladores saem das
 * GitHub Releases do repositório: o site só aponta para lá, com os nomes fixos
 * que a release publica.
 */

export type DownloadStatus = 'em-breve' | 'disponivel';

export interface Download {
  readonly id: 'windows' | 'macos' | 'linux';
  readonly plataforma: string;
  readonly status: DownloadStatus;
  /** Link direto do instalador quando `status` for `disponivel`. */
  readonly url: string | null;
  /** Nome do arquivo na release (sem versão), para a página montar o link da versão mais nova. */
  readonly arquivo?: string;
}

export const site = {
  nome: 'FaKL-Code',
  nomeLongo: 'FaKL-Code IDE',
  /** Endereço público, de PUBLIC_SITE_URL no build (o mesmo do astro.config). */
  url: (import.meta.env.PUBLIC_SITE_URL as string | undefined) ?? 'https://exemplo.com',
  /** Repositório aberto (AGPL) da IDE. */
  repo: 'https://github.com/FaKL-Code/FaKL-Code-IDE',
  /**
   * Filme de lançamento (MP4), de PUBLIC_FILME no build. O vídeo não fica no
   * git; vazio, o botão abre um aviso de "em breve".
   */
  filme: (import.meta.env.PUBLIC_FILME as string | undefined) ?? '',
  /**
   * Manifesto que o release.yml atualiza a cada versão (ADR 0037). A página de
   * download lê a tag dele e troca os links; os de `downloads` valem se a leitura falhar.
   */
  manifestoDaVersao:
    'https://raw.githubusercontent.com/FaKL-Code/FaKL-Code-IDE/atualizacoes/latest.json',
  downloads: [
    {
      id: 'windows',
      plataforma: 'Windows',
      status: 'disponivel',
      url: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.13/FaKL-Code-Windows-x64.exe',
      arquivo: 'FaKL-Code-Windows-x64.exe',
    },
    {
      id: 'macos',
      plataforma: 'macOS',
      status: 'disponivel',
      url: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.13/FaKL-Code-macOS-arm64.zip',
      arquivo: 'FaKL-Code-macOS-arm64.zip',
    },
    {
      id: 'linux',
      plataforma: 'Linux',
      status: 'disponivel',
      url: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.13/FaKL-Code-Linux-x64.tar.gz',
      arquivo: 'FaKL-Code-Linux-x64.tar.gz',
    },
  ] satisfies readonly Download[] as readonly Download[],
} as const;
