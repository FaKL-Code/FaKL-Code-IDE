import { describe, expect, it } from 'vitest';

import type { OverlayBridge, OverlayShape } from '../src/bridge.js';
import { Overlay } from '../src/store.js';

/** Ponte de teste: o "Não perturbe" mora nela, como no processo principal. */
class FakeBridge implements OverlayBridge {
  readonly quietRequests: boolean[] = [];
  readonly modes: OverlayShape[] = [];
  private quietListener: (quiet: boolean) => void = () => undefined;

  readonly send = (): undefined => undefined;
  readonly onFrame = (): undefined => undefined;
  readonly onStatus = (): undefined => undefined;
  readonly onCommand = (): undefined => undefined;
  readonly onSide = (): undefined => undefined;
  readonly setClickThrough = (): undefined => undefined;
  readonly hide = (): undefined => undefined;
  readonly quit = (): undefined => undefined;

  setMode(mode: OverlayShape): void {
    this.modes.push(mode);
  }

  setQuiet(quiet: boolean): void {
    this.quietRequests.push(quiet);
  }

  onQuiet(listener: (quiet: boolean) => void): void {
    this.quietListener = listener;
  }

  /** A bandeja (ou o próprio pedido do painel) mudou o valor no principal. */
  pushQuiet(quiet: boolean): void {
    this.quietListener(quiet);
  }
}

describe('Overlay: "Não perturbe" vem do processo principal', () => {
  it('começa desligado e segue o que o principal avisa', () => {
    const bridge = new FakeBridge();
    const overlay = new Overlay(bridge);
    expect(overlay.prefs.naoPerturbe).toBe(false);
    let changes = 0;
    overlay.onChange(() => changes++);
    overlay.bubble = { text: 'Revisor terminou', until: Date.now() + 5_000 };
    bridge.pushQuiet(true);
    expect(overlay.prefs.naoPerturbe).toBe(true);
    expect(overlay.bubble).toBeUndefined();
    expect(changes).toBe(1);
    bridge.pushQuiet(false);
    expect(overlay.prefs.naoPerturbe).toBe(false);
  });

  it('o painel pede a mudança pela ponte', () => {
    const bridge = new FakeBridge();
    const overlay = new Overlay(bridge);
    overlay.setPref('naoPerturbe', true);
    overlay.setPref('fixado', true);
    expect(bridge.quietRequests).toEqual([true]);
  });
});
