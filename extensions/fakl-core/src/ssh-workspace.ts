import type { SshRemoteRoot } from '@fakl/protocol';

/*
 * Pastas remotas (`fakl-ssh://alias/caminho`) como raízes adicionais do workspace
 * multi-root, na mesma janela (ADR 0019). Aqui fica a lógica pura, sem `vscode`,
 * para testar: quem monta o QuickPick e chama a API da IDE é `ssh.ts`.
 */

export const SSH_SCHEME = 'fakl-ssh';

export interface UriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
}

export interface FolderLike {
  readonly uri: UriLike;
  readonly name?: string;
}

/** O que usamos de `vscode.workspace`, injetável nos testes. */
export interface WorkspaceLike<U extends UriLike = UriLike> {
  readonly workspaceFolders: readonly FolderLike[] | undefined;
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...foldersToAdd: { uri: U; name?: string }[]
  ): boolean;
}

/** `/a/b/` e `/a/b` são a mesma pasta; a raiz continua `/`. */
export function normalizeRemotePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const trimmed = withSlash.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Nome da raiz no explorador: `host:caminho`. */
export function remoteName(alias: string, path: string): string {
  return `${alias}:${normalizeRemotePath(path)}`;
}

export function isRemoteFolder(folder: FolderLike): boolean {
  return folder.uri.scheme === SSH_SCHEME;
}

/** Raízes remotas do workspace, com o índice de cada uma. */
export function remoteFolders(
  folders: readonly FolderLike[] | undefined,
): { index: number; alias: string; path: string; folder: FolderLike }[] {
  const result: { index: number; alias: string; path: string; folder: FolderLike }[] = [];
  (folders ?? []).forEach((folder, index) => {
    if (isRemoteFolder(folder)) {
      result.push({
        index,
        alias: folder.uri.authority,
        path: normalizeRemotePath(folder.uri.path),
        folder,
      });
    }
  });
  return result;
}

/** Host e caminho de cada raiz remota, para o prompt do agente (`agents.start`). */
export function remoteRoots(folders: readonly FolderLike[] | undefined): SshRemoteRoot[] {
  return remoteFolders(folders).map(({ alias, path }) => ({ host: alias, caminho: path }));
}

/** Primeira pasta local (`file://`): é nela que o agente (e o worktree) trabalha. */
export function firstLocalFolder<T extends FolderLike>(
  folders: readonly T[] | undefined,
): T | undefined {
  return (folders ?? []).find((folder) => folder.uri.scheme === 'file');
}

export type AddPlan =
  | { readonly kind: 'exists'; readonly index: number }
  | {
      readonly kind: 'add';
      readonly index: number;
      readonly name: string;
      /**
       * Sem pasta (ou com uma só) a IDE pode reiniciar o extension host ao
       * mudar de modo; o aviso ao usuário e a espera pelo reinício dependem disso.
       */
      readonly mayRestartExtensionHost: boolean;
    };

/** O que fazer para ter `alias:path` no workspace: já está lá, ou entra no fim da lista. */
export function planAdd(
  folders: readonly FolderLike[] | undefined,
  alias: string,
  path: string,
): AddPlan {
  const wanted = normalizeRemotePath(path);
  const existing = remoteFolders(folders).find((r) => r.alias === alias && r.path === wanted);
  if (existing) return { kind: 'exists', index: existing.index };
  const count = folders?.length ?? 0;
  return {
    kind: 'add',
    index: count,
    name: remoteName(alias, wanted),
    mayRestartExtensionHost: count <= 1,
  };
}

export type AddOutcome =
  | { readonly kind: 'exists'; readonly index: number }
  | { readonly kind: 'added'; readonly index: number; readonly mayRestartExtensionHost: boolean }
  | { readonly kind: 'failed' };

/** Adiciona a raiz remota ao workspace da janela atual (nunca abre outra janela). */
export function addRemoteFolder<U extends UriLike>(
  workspace: WorkspaceLike<U>,
  makeUri: (alias: string, path: string) => U,
  alias: string,
  path: string,
): AddOutcome {
  const plan = planAdd(workspace.workspaceFolders, alias, path);
  if (plan.kind === 'exists') return plan;
  const ok = workspace.updateWorkspaceFolders(plan.index, 0, {
    uri: makeUri(alias, normalizeRemotePath(path)),
    name: plan.name,
  });
  return ok
    ? { kind: 'added', index: plan.index, mayRestartExtensionHost: plan.mayRestartExtensionHost }
    : { kind: 'failed' };
}

/** Remove uma raiz remota do workspace; `false` se ela não está (ou a IDE recusou). */
export function removeRemoteFolder(workspace: WorkspaceLike, alias: string, path: string): boolean {
  const wanted = normalizeRemotePath(path);
  const found = remoteFolders(workspace.workspaceFolders).find(
    (r) => r.alias === alias && r.path === wanted,
  );
  return found ? workspace.updateWorkspaceFolders(found.index, 1) : false;
}

/** Chave estável de uma raiz remota (terminais, caches). */
export function rootKey(alias: string, path: string): string {
  return `${alias}${normalizeRemotePath(path)}`;
}
