/** Armazenamento de mentira para a prévia: uma máquina já pareada. */
import type { KeyPair } from '@fakl/remote';

import type { SavedMachine } from '../src/storage.js';

export type { SavedMachine };

const machine: SavedMachine = {
  target: { relay: 'https://relay.exemplo.dev', machine: 'previa', coreKey: 'A'.repeat(87) },
  nome: 'Notebook de casa',
  deviceId: 'aparelho',
  escopos: ['ver', 'decidir', 'comandar'],
  keys: {} as KeyPair,
};

export function loadMachine(): Promise<SavedMachine | undefined> {
  return Promise.resolve(location.search.includes('sem-maquina') ? undefined : machine);
}

export function saveMachine(): Promise<void> {
  return Promise.resolve();
}

export function forgetMachine(): Promise<void> {
  return Promise.resolve();
}
