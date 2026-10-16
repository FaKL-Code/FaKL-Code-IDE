/** `fetch` injetável: nos testes, uma função falsa; em produção, o `fetch` global. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Resposta de erro de uma API, com o status e a mensagem que ela devolveu. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Lê o corpo como JSON quando houver; texto vazio vira `undefined`. */
export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Mensagem legível de um corpo de erro (`message`, `error`, `errors`). */
export function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  if (typeof body === 'object' && body !== null) {
    const b = body as { message?: unknown; error?: unknown; error_description?: unknown };
    for (const value of [b.message, b.error_description, b.error]) {
      if (typeof value === 'string' && value) return value;
    }
  }
  return fallback;
}
