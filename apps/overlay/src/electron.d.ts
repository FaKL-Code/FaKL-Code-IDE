/**
 * O pedaço do `electron` que o preload usa. O pacote não é dependência do
 * monorepo: o preload roda dentro do Electron da IDE, que o fornece.
 */
declare module 'electron' {
  interface IpcRendererEvent {
    readonly sender: unknown;
  }

  export const ipcRenderer: {
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
}
