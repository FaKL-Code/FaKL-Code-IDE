import type { CiRun, CiState, CiStatus } from '@fakl/protocol';

import { kitchenSprites } from './art/cozinha.js';
import { C, KEY } from './art/palette.js';
import {
  allRuns,
  cellAt,
  CELL_H,
  CELL_W,
  cupFrame,
  CUPS_MAX,
  HEADER_H,
  kitchenLayout,
  kitchenRuns,
  mergeRun,
  pixelClock,
  runSeconds,
  stationLook,
} from './cozinha-model.js';
import { context, text } from './pixel.js';
import { draw, register, tinted } from './sprites.js';

/*
 * Cozinha do CI (ADR 0051): uma bancada por execução do GitHub Actions, com um
 * cozinheiro e uma xícara por job. Canvas 2D num quadro de 1x ampliado sem
 * suavizar (CSS `image-rendering: pixelated`), no estilo do resto do café.
 * Só reflete o que o Core publica (`CafeState.ci` e eventos `ci.run`).
 */

export interface KitchenOptions {
  readonly canvas: HTMLCanvasElement;
  /** Clicaram numa bancada. */
  readonly onOpen: (run: CiRun) => void;
  /** As execuções na bancada mudaram; a lista e o texto de acessibilidade se refazem. */
  readonly onChange?: () => void;
  /** Tira execuções da bancada antes do corte de 8 (as dispensadas e as que já saíram); sem isto, vale tudo. */
  readonly filter?: (runs: readonly CiRun[], now: number) => readonly CiRun[];
}

export interface Kitchen {
  /** Retrato completo (`cafe.state` ou `ci.status`). */
  apply(status: CiStatus | undefined): void;
  /** Uma execução que mudou (evento `ci.run`). */
  onRun(run: CiRun): void;
  setOffline(value: boolean): void;
  /** O retrato mais recente. */
  readonly status: CiStatus | undefined;
  /** As execuções que estão na bancada agora, na ordem em que aparecem. */
  runs(): CiRun[];
  /** Redesenha com o que o `filter` deixa passar agora (depois de dispensar ou restaurar). */
  refresh(): void;
  pause(): void;
  resume(): void;
}

const FPS = 8;
const MOOD: Record<string, string> = {
  work: C.neon,
  wait: C.yellow,
  ok: C.green,
  bad: C.red,
  off: C.metalDark,
};
const SKINS: [string, string][] = [
  ['#f1c27d', '#e0ac69'],
  ['#e0ac69', '#c68642'],
  ['#c68642', '#8d5524'],
  ['#8d5524', '#6b3f1b'],
  ['#ffdbac', '#f1c27d'],
];

function hash(value: string): number {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function mountKitchen(options: KitchenOptions): Kitchen {
  const { canvas } = options;
  register(kitchenSprites);
  const ctx = context(canvas);
  let status: CiStatus | undefined;
  let shown: CiRun[] = [];
  let offline = false;
  let reduced = false;
  let timer: number | undefined;
  let last = 0;

  const px = (x: number, y: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  };
  const rect = (x: number, y: number, w: number, h: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const digits = (value: string, x: number, y: number, color: string): void => {
    text(value, (u, v) => {
      px(x + u, y + v, color);
    });
  };

  function header(width: number): void {
    rect(0, 0, width, HEADER_H, C.darker);
    rect(0, HEADER_H - 1, width, 1, C.wainscotRail);
    const streak = status?.verdesSeguidos ?? 0;
    const failing = status?.falhando ?? 0;
    const working = status?.trabalhando ?? 0;
    // Visto verde: builds verdes seguidos.
    const check = (x: number, y: number): void => {
      px(x, y + 3, C.green);
      px(x + 1, y + 4, C.green);
      px(x + 2, y + 3, C.green);
      px(x + 3, y + 2, C.green);
      px(x + 4, y + 1, C.green);
      px(x + 5, y, C.green);
    };
    // Cruz vermelha: fluxos falhando.
    const cross = (x: number, y: number): void => {
      for (let i = 0; i < 5; i++) {
        px(x + i, y + i, C.red);
        px(x + 4 - i, y + i, C.red);
      }
    };
    // Xícara: execuções em andamento.
    const cup = (x: number, y: number): void => {
      rect(x, y + 1, 5, 4, C.neon);
      px(x + 5, y + 2, C.neon);
      px(x + 5, y + 3, C.neon);
      px(x + 1, y - 1, C.neonDim);
      px(x + 3, y - 1, C.neonDim);
    };
    const third = Math.floor(width / 3);
    check(4, 5);
    digits(String(streak), 13, 5, C.text);
    cross(third + 4, 5);
    digits(String(failing), third + 13, 5, failing > 0 ? C.red : C.muted);
    cup(2 * third + 4, 5);
    digits(String(working), 2 * third + 13, 5, working > 0 ? C.neon : C.muted);
  }

  function station(run: CiRun, index: number, columns: number, tick: number, now: number): void {
    const cx = (index % columns) * CELL_W;
    const cy = HEADER_H + Math.floor(index / columns) * CELL_H;
    const look = stationLook(run.estado, tick, reduced);
    const mood = MOOD[look.mood] ?? C.metalDark;
    // Fundo: parede da cozinha; na falha, o vermelho pisca devagar.
    const alarm = look.mood === 'bad' && !reduced && tick % 4 < 2;
    rect(cx + 1, cy + 1, CELL_W - 2, CELL_H - 2, alarm ? '#2a1218' : C.wall);
    rect(cx + 1, cy + 1, CELL_W - 2, 4, alarm ? '#3a1820' : C.wallDark);
    rect(cx + 1, cy + CELL_H - 4, CELL_W - 2, 3, mood);
    // Moldura em cor do estado.
    rect(cx, cy, CELL_W, 1, mood);
    rect(cx, cy + CELL_H - 1, CELL_W, 1, mood);
    rect(cx, cy, 1, CELL_H, mood);
    rect(cx + CELL_W - 1, cy, 1, CELL_H, mood);
    // Relógio da execução, no canto.
    const clock = pixelClock(runSeconds(run, now));
    digits(clock, cx + CELL_W - 4 - clock.length * 4 + 1, cy + 7, C.text);
    // Sem cozinheiro (execução cancelada): o avental fica no gancho.
    if (look.cook === undefined) {
      draw(ctx, 'kitchen-apron', cx + 36, cy + 52);
    } else {
      const skin = SKINS[hash(`${run.repo}/${run.nome}`) % SKINS.length] ?? SKINS[0];
      const swaps = new Map<string, string>([
        [KEY.skin, skin?.[0] ?? KEY.skin],
        [KEY.skinDark, skin?.[1] ?? KEY.skinDark],
      ]);
      draw(ctx, 'kitchen-cook', cx + 36, cy + 62, look.cook, 0, {
        image: tinted(
          'kitchen-cook',
          `skin${String(hash(`${run.repo}/${run.nome}`) % SKINS.length)}`,
          swaps,
        ),
      });
      if (look.mood === 'bad') {
        draw(ctx, 'kitchen-smoke', cx + 36, cy + 16, reduced ? 1 : tick, 0, { alpha: 0.85 });
      }
    }
    draw(ctx, 'kitchen-counter', cx + 4, cy + 56);
    // Adereço do estado, no canto esquerdo do balcão.
    const propFrame = reduced ? 0 : tick % 2;
    if (look.prop === 'bell') draw(ctx, 'kitchen-bell', cx + 13, cy + 56, propFrame);
    else if (look.prop === 'alarm')
      draw(ctx, 'kitchen-alarm', cx + 12, cy + 56, reduced ? 1 : propFrame);
    else if (look.prop === 'ticket') {
      draw(ctx, 'kitchen-ticket', cx + 12, cy + 56, propFrame);
      draw(ctx, 'kitchen-ticket', cx + 20, cy + 52, (propFrame + 1) % 2, 0, { alpha: 0.7 });
    } else if (look.prop === 'steam') {
      draw(ctx, 'kitchen-steam', cx + 56, cy + 44, reduced ? 1 : tick);
    }
    // Uma xícara por job, no tampo.
    const jobs = run.jobs.slice(0, CUPS_MAX);
    jobs.forEach((job, i) => {
      draw(ctx, 'kitchen-cup', cx + 27 + i * 9, cy + 56, cupFrame(job.estado, tick + i, reduced));
    });
    if (run.jobs.length === 0) {
      // Jobs ainda não lidos: uma xícara só, no estado da execução.
      draw(ctx, 'kitchen-cup', cx + 27, cy + 56, cupFrame(run.estado, tick, reduced));
    }
    if (run.jobs.length > CUPS_MAX) {
      digits(`+${String(run.jobs.length - CUPS_MAX)}`, cx + 27, cy + 66, C.muted);
    }
    // Número da execução na frente do balcão.
    digits(String(run.numero), cx + 8, cy + 70, C.cream);
  }

  function render(): void {
    const now = Date.now();
    const all = allRuns(status);
    shown = kitchenRuns(options.filter ? [...options.filter(all, now)] : all, now);
    const layout = kitchenLayout(shown.length);
    if (canvas.width !== layout.width || canvas.height !== layout.height) {
      canvas.width = layout.width;
      canvas.height = layout.height;
      ctx.imageSmoothingEnabled = false;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rect(0, 0, canvas.width, canvas.height, C.ink);
    header(layout.width);
    const tick = Math.floor(now / (1000 / 2));
    shown.forEach((run, i) => {
      station(run, i, layout.columns, tick, now);
    });
    if (offline) {
      ctx.globalAlpha = 0.5;
      rect(0, 0, canvas.width, canvas.height, C.out);
      ctx.globalAlpha = 1;
    }
  }

  function frame(time: number): void {
    timer = window.requestAnimationFrame(frame);
    if (time - last < 1000 / (reduced ? 1 : FPS)) return;
    last = time;
    render();
  }

  function resume(): void {
    if (timer !== undefined || document.hidden) return;
    timer = window.requestAnimationFrame(frame);
  }

  function pause(): void {
    if (timer !== undefined) window.cancelAnimationFrame(timer);
    timer = undefined;
  }

  const logical = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) * canvas.width) / Math.max(1, r.width),
      y: ((event.clientY - r.top) * canvas.height) / Math.max(1, r.height),
    };
  };
  canvas.addEventListener('click', (event) => {
    const p = logical(event);
    const index = cellAt(p.x, p.y, shown.length);
    const run = index === undefined ? undefined : shown[index];
    if (run) options.onOpen(run);
  });
  canvas.addEventListener('pointermove', (event) => {
    const p = logical(event);
    canvas.style.cursor = cellAt(p.x, p.y, shown.length) === undefined ? 'default' : 'pointer';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else resume();
  });
  if (typeof window.matchMedia === 'function') {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = motion.matches;
    motion.addEventListener('change', () => {
      reduced = motion.matches;
      render();
    });
  }
  canvas.width = kitchenLayout(0).width;
  canvas.height = kitchenLayout(0).height;
  render();
  resume();

  const changed = (): void => {
    render();
    options.onChange?.();
  };
  return {
    apply: (next) => {
      status = next;
      changed();
    },
    onRun: (run) => {
      // Evento antes do primeiro retrato (ou de um repositório que não acompanhamos): ignora.
      if (!status?.repos.some((r) => r.repo === run.repo)) return;
      status = mergeRun(status, run);
      changed();
    },
    setOffline: (value) => {
      offline = value;
      render();
    },
    get status() {
      return status;
    },
    runs: () => shown,
    refresh: changed,
    pause,
    resume,
  };
}

/** Estados que a interface distingue por cor além do texto (para os cartões). */
export const CI_STATE_COLOR: Record<CiState, string> = {
  fila: C.muted,
  trabalhando: C.neon,
  aguardando: C.yellow,
  sucesso: C.green,
  falha: C.red,
  cancelada: C.metalDark,
};
