import { l10n } from '@fakl/i18n';

import { errorMessage, HttpError } from '../http.js';

/** Por que o GitHub recusou um pedido, quando dá para explicar em linguagem simples. */
export type GitHubErrorKind = 'sso' | 'token-sem-acesso' | 'escopo' | 'limite' | 'login';

/** Erro da API com uma explicação em português e o que o usuário pode fazer. */
export class GitHubError extends HttpError {
  constructor(
    status: number,
    message: string,
    body: unknown,
    readonly kind?: GitHubErrorKind,
    /** URL para autorizar o token numa organização com SSO, quando o GitHub informou. */
    readonly ssoUrl?: string,
    /** Quando o limite de requisições volta (ms desde a época). */
    readonly retryAt?: number,
  ) {
    super(status, message, body);
  }
}

function minutesUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 60_000));
}

/** Erro de limite de requisições já esgotado, sem ter chamado a API. */
export function rateLimitError(retryAt: number, now: number): GitHubError {
  return new GitHubError(
    429,
    l10n.t(
      'GitHub: request limit reached; try again in {0} min.',
      String(minutesUntil(retryAt, now)),
    ),
    undefined,
    'limite',
    undefined,
    retryAt,
  );
}

/**
 * Traduz uma resposta de erro do GitHub. Cobre o que quem tem organizações
 * encontra: SSO/SAML não autorizado, token fine-grained sem acesso ao
 * recurso, escopo faltando e limite de requisições (ADR 0020).
 */
export function explainGitHubError(
  status: number,
  headers: Headers,
  data: unknown,
  now = Date.now(),
): GitHubError {
  const raw = errorMessage(data, '');
  const sso = headers.get('x-github-sso');
  if (status === 403 && (sso || /saml|single sign-on/i.test(raw))) {
    const url = /url=([^;\s]+)/.exec(sso ?? '')?.[1];
    return new GitHubError(
      status,
      l10n.t(
        'GitHub 403: the organization requires SSO and the token has not been authorized for it yet. At github.com/settings/tokens (or in Authorized applications), use "Configure SSO" and authorize the organization{0}',
        url ? `: ${url}` : '.',
      ),
      data,
      'sso',
      url,
    );
  }
  const remaining = headers.get('x-ratelimit-remaining');
  const retryAfter = headers.get('retry-after');
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || retryAfter || /rate limit|abuse/i.test(raw)))
  ) {
    const reset = Number(headers.get('x-ratelimit-reset'));
    const retryAt = retryAfter
      ? now + Number(retryAfter) * 1000
      : Number.isFinite(reset) && reset > 0
        ? reset * 1000
        : now + 60_000;
    return rateLimitError(retryAt, now);
  }
  if (status === 401) {
    return new GitHubError(
      status,
      l10n.t('GitHub 401: invalid or expired token. Sign in again (FaKL: Sign in to GitHub).'),
      data,
      'login',
    );
  }
  const accepted = headers.get('x-accepted-github-permissions');
  if (
    (status === 403 || status === 404) &&
    /resource not accessible by (personal access token|integration)|fine-grained/i.test(raw)
  ) {
    return new GitHubError(
      status,
      l10n.t(
        'GitHub {0}: the token does not have access to this resource. On a fine-grained token, choose "All repositories" (or include the repository) and the permissions Pull requests, Issues, Actions and Metadata{1}. Organizations must have approved the fine-grained token.',
        String(status),
        accepted ? l10n.t(' (this call requires: {0})', accepted) : '',
      ),
      data,
      'token-sem-acesso',
    );
  }
  const scopes = headers.get('x-oauth-scopes');
  const wanted = headers.get('x-accepted-oauth-scopes');
  if (status === 403 && scopes !== null && wanted) {
    const have = scopes.split(/,\s*/);
    if (!wanted.split(/,\s*/).some((scope) => have.includes(scope))) {
      return new GitHubError(
        status,
        l10n.t(
          'GitHub 403: scope {0} is missing from the token (has: {1}). Sign in again from the IDE to renew the scopes.',
          wanted,
          scopes || l10n.t('none'),
        ),
        data,
        'escopo',
      );
    }
  }
  return new GitHubError(status, `GitHub ${String(status)}: ${raw || l10n.t('error')}`, data);
}
