/*
 * Cada janela da IDE mostra só o que é da sua pasta: as tarefas, as sessões de
 * agente e a Mesa de um projeto não aparecem nos outros. O Core é um só para
 * todas as janelas e guarda tudo; o recorte é feito aqui, pelas pastas abertas.
 */

function normalizar(path: string, insensivel: boolean): string {
  const limpo = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return insensivel ? limpo.toLowerCase() : limpo;
}

/**
 * `path` é uma das pastas ou está dentro de uma delas. Sem pastas (janela vazia
 * ou só com pastas remotas) não há o que isolar e tudo passa.
 */
export function naPasta(
  path: string | undefined,
  pastas: readonly string[],
  insensivel = process.platform === 'win32' || process.platform === 'darwin',
): boolean {
  if (pastas.length === 0) return true;
  if (!path) return false;
  const alvo = normalizar(path, insensivel);
  return pastas.some((pasta) => {
    const base = normalizar(pasta, insensivel);
    return alvo === base || alvo.startsWith(`${base}/`);
  });
}

/** As pastas locais (`file://`) abertas nesta janela. */
export function pastasLocais(
  folders:
    readonly { readonly uri: { readonly scheme: string; readonly fsPath: string } }[] | undefined,
): string[] {
  return (folders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}
