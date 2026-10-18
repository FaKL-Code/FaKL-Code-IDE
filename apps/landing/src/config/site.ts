/**
 * Tudo o que muda sem mexer nas páginas: endereço, links de download e filme.
 * Os textos em cada idioma ficam em `src/i18n`. Os instaladores saem das
 * GitHub Releases do repositório: o site só aponta para lá, com os nomes fixos
 * que a release publica.
 */

export type DownloadStatus = 'em-breve' | 'disponivel';

export interface Download {
  readonly id: 'windows' | 'macos';
  readonly plataforma: string;
  readonly status: DownloadStatus;
  /** Link direto do instalador quando `status` for `disponivel`. */
  readonly url: string | null;
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
  downloads: [
    {
      id: 'windows',
      plataforma: 'Windows',
      status: 'disponivel',
      url: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.4/FaKL-Code-Windows-x64.exe',
    },
    {
      id: 'macos',
      plataforma: 'macOS',
      status: 'disponivel',
      url: 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.4/FaKL-Code-macOS-arm64.zip',
    },
  ] satisfies readonly Download[] as readonly Download[],
} as const;
