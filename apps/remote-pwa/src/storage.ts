import { l10n } from '@fakl/i18n';
import type { DeviceTarget, KeyPair, RemoteScope } from '@fakl/remote';

/** Uma máquina pareada, guardada no IndexedDB deste navegador. */
export interface SavedMachine {
  readonly target: DeviceTarget;
  readonly nome: string;
  readonly deviceId: string;
  readonly escopos: readonly RemoteScope[];
  /** A chave privada não sai deste navegador (não extraível). */
  readonly keys: KeyPair;
}

const DB = 'fakl-remoto';
const STORE = 'maquinas';
const KEY = 'atual';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(l10n.t('IndexedDB unavailable')));
    };
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => {
        resolve(request.result as T);
      };
      request.onerror = () => {
        reject(request.error ?? new Error(l10n.t('IndexedDB failed')));
      };
    });
  } finally {
    db.close();
  }
}

export function loadMachine(): Promise<SavedMachine | undefined> {
  return run<SavedMachine | undefined>('readonly', (store) => store.get(KEY));
}

export async function saveMachine(machine: SavedMachine): Promise<void> {
  await run('readwrite', (store) => store.put(machine, KEY));
  // Pede ao navegador para não apagar as chaves quando faltar espaço.
  await navigator.storage.persist().catch(() => false);
}

export async function forgetMachine(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY));
}
