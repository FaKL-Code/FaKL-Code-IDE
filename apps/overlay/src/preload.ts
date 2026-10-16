/**
 * Preload do overlay (vira `dist/overlay/preload.cjs`). Roda com
 * `contextIsolation` e `sandbox`: só expõe `window.faklOverlay`, com cada
 * canal IPC tipado; a página nunca recebe o `ipcRenderer` nem o evento do IPC.
 */
import { contextBridge, ipcRenderer } from 'electron';

import {
  OverlayChannels,
  type BalloonSide,
  type OverlayBridge,
  type OverlayCommand,
  type OverlayShape,
  type OverlayStatus,
} from './bridge.js';

const MODES: readonly OverlayShape[] = ['pet', 'painel', 'balao'];
const SIDES: readonly BalloonSide[] = ['esquerda', 'direita'];
const STATUSES: readonly OverlayStatus[] = ['online', 'offline'];
const COMMANDS: readonly OverlayCommand[] = ['compor', 'painel', 'pet'];

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const bridge: OverlayBridge = {
  send(frame) {
    if (typeof frame === 'string') ipcRenderer.send(OverlayChannels.send, frame);
  },
  onFrame(listener) {
    ipcRenderer.on(OverlayChannels.frame, (_event, frame) => {
      if (typeof frame === 'string') listener(frame);
    });
  },
  onStatus(listener) {
    ipcRenderer.on(OverlayChannels.status, (_event, status) => {
      if (isOneOf(STATUSES, status)) listener(status);
    });
    // Quem escuta o estado chegou: o principal reenvia o atual.
    ipcRenderer.send(OverlayChannels.ready);
  },
  setMode(mode) {
    if (isOneOf(MODES, mode)) ipcRenderer.send(OverlayChannels.mode, mode);
  },
  onSide(listener) {
    ipcRenderer.on(OverlayChannels.side, (_event, side) => {
      if (isOneOf(SIDES, side)) listener(side);
    });
  },
  setClickThrough(through) {
    if (typeof through === 'boolean') ipcRenderer.send(OverlayChannels.clickThrough, through);
  },
  setQuiet(quiet) {
    if (typeof quiet === 'boolean') ipcRenderer.send(OverlayChannels.setQuiet, quiet);
  },
  onQuiet(listener) {
    ipcRenderer.on(OverlayChannels.quiet, (_event, quiet) => {
      if (typeof quiet === 'boolean') listener(quiet);
    });
  },
  hide() {
    ipcRenderer.send(OverlayChannels.hide);
  },
  quit() {
    ipcRenderer.send(OverlayChannels.quit);
  },
  onCommand(listener) {
    ipcRenderer.on(OverlayChannels.command, (_event, command) => {
      if (isOneOf(COMMANDS, command)) listener(command);
    });
  },
};

contextBridge.exposeInMainWorld('faklOverlay', bridge);
