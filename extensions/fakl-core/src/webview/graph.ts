import { l10n, useLocale } from '@fakl/i18n';

import type { ToTips } from '../tour-protocol.js';
import type { GraphFromWebview, GraphToWebview, VaultGraphData } from '../vault-graph-protocol.js';
import { initCoach } from './coach.js';

/*
 * Grafo do vault (RF-403): nós são notas, arestas são wikilinks. Layout por
 * forças (repulsão, molas e gravidade) num canvas; arrastar move a vista,
 * a roda dá zoom, clicar abre a nota e passar o mouse destaca os vizinhos.
 */

interface VsCodeApi {
  postMessage(message: GraphFromWebview): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();

interface Node {
  path: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  folder: string;
}

const canvas = document.getElementById('grafo') as HTMLCanvasElement;
const filterInput = document.getElementById('filtro') as HTMLInputElement;
const info = document.getElementById('info') as HTMLDivElement;
const context2d = canvas.getContext('2d');
if (!context2d) throw new Error(l10n.t('2D canvas unavailable.'));
const ctx = context2d;

let nodes: Node[] = [];
let byPath = new Map<string, Node>();
let edges: [Node, Node][] = [];
let neighbors = new Map<Node, Set<Node>>();
let current: string | undefined;
let hover: Node | undefined;
let filter = '';
let view = { x: 0, y: 0, scale: 1 };
let heat = 1;
let frame = 0;

const style = getComputedStyle(document.body);
const color = (name: string, fallback: string): string =>
  style.getPropertyValue(name).trim() || fallback;
const FG = color('--vscode-foreground', '#ccc');
const MUTED = color('--vscode-descriptionForeground', '#888');
const ACCENT = color('--vscode-textLink-foreground', '#4a8fd9');
const PALETTE = ['#e07a5f', '#81b29a', '#f2cc8f', '#9b8fd6', '#5fa8d3', '#d67ab1', '#a3b18a'];

function folderColor(folder: string): string {
  let h = 0;
  for (const c of folder) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return folder ? (PALETTE[h % PALETTE.length] ?? MUTED) : MUTED;
}

function load(graph: VaultGraphData): void {
  const previous = byPath;
  nodes = graph.nodes.map((n, i) => {
    const old = previous.get(n.path);
    const angle = i * 2.399963;
    const radius = 12 * Math.sqrt(i + 1);
    return {
      path: n.path,
      title: n.title,
      x: old?.x ?? Math.cos(angle) * radius,
      y: old?.y ?? Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: 0,
      folder: n.path.includes('/') ? (n.path.split('/')[0] ?? '') : '',
    };
  });
  byPath = new Map(nodes.map((n) => [n.path, n]));
  neighbors = new Map(nodes.map((n) => [n, new Set<Node>()]));
  edges = [];
  for (const [from, to] of graph.edges) {
    const a = byPath.get(from);
    const b = byPath.get(to);
    if (!a || !b) continue;
    edges.push([a, b]);
    a.degree++;
    b.degree++;
    neighbors.get(a)?.add(b);
    neighbors.get(b)?.add(a);
  }
  heat = 1;
  const notas = nodes.length === 1 ? l10n.t('1 note') : l10n.t('{0} notes', nodes.length);
  const links = edges.length === 1 ? l10n.t('1 link') : l10n.t('{0} links', edges.length);
  info.textContent = `${notas} · ${links}`;
  start();
}

function simulate(): void {
  const count = nodes.length;
  // Repulsão: todos contra todos até ~600 notas; acima disso, amostra vizinhos próximos.
  const step = count > 600 ? Math.ceil(count / 600) : 1;
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    if (!a) continue;
    for (let j = i + 1; j < count; j += step) {
      const b = nodes[j];
      if (!b) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = 0.25;
      }
      if (d2 > 250_000) continue;
      const force = (2500 * step) / d2;
      const d = Math.sqrt(d2);
      a.vx += (dx / d) * force;
      a.vy += (dy / d) * force;
      b.vx -= (dx / d) * force;
      b.vy -= (dy / d) * force;
    }
  }
  for (const [a, b] of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (d - 60) * 0.02;
    a.vx += (dx / d) * force;
    a.vy += (dy / d) * force;
    b.vx -= (dx / d) * force;
    b.vy -= (dy / d) * force;
  }
  for (const n of nodes) {
    n.vx -= n.x * 0.004;
    n.vy -= n.y * 0.004;
    n.vx *= 0.8;
    n.vy *= 0.8;
    n.x += n.vx * heat;
    n.y += n.vy * heat;
  }
  heat = Math.max(0, heat - 0.003);
}

function radius(n: Node): number {
  return 3 + Math.min(9, Math.sqrt(n.degree) * 1.6);
}

function visible(n: Node): boolean {
  return !filter || n.title.toLowerCase().includes(filter) || n.path.toLowerCase().includes(filter);
}

function draw(): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(width / 2 + view.x, height / 2 + view.y);
  ctx.scale(view.scale, view.scale);

  const focus = hover ?? (current ? byPath.get(current) : undefined);
  const near = focus ? neighbors.get(focus) : undefined;
  ctx.lineWidth = 1 / view.scale;
  for (const [a, b] of edges) {
    if (!visible(a) || !visible(b)) continue;
    const lit = focus !== undefined && (a === focus || b === focus);
    ctx.strokeStyle = lit ? ACCENT : MUTED;
    ctx.globalAlpha = lit ? 0.9 : focus ? 0.12 : 0.35;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = `${String(11 / view.scale)}px sans-serif`;
  ctx.textAlign = 'center';
  for (const n of nodes) {
    if (!visible(n)) continue;
    const dim = focus !== undefined && n !== focus && !near?.has(n);
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
    ctx.fillStyle = n.path === current ? ACCENT : folderColor(n.folder);
    ctx.fill();
    const label =
      n === focus || near?.has(n) === true || view.scale > 1.4 || (filter !== '' && visible(n));
    if (label) {
      ctx.fillStyle = FG;
      ctx.fillText(n.title, n.x, n.y - radius(n) - 3 / view.scale);
    }
  }
  ctx.globalAlpha = 1;
}

function loop(): void {
  frame = requestAnimationFrame(loop);
  // No começo, vários passos por quadro para o layout assentar rápido.
  const steps = heat > 0.5 ? 4 : heat > 0 ? 1 : 0;
  for (let i = 0; i < steps; i++) simulate();
  draw();
}

function start(): void {
  if (!frame) frame = requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = 0;
  } else start();
});

function toWorld(event: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - rect.width / 2 - view.x) / view.scale,
    y: (event.clientY - rect.top - rect.height / 2 - view.y) / view.scale,
  };
}

function nodeAt(event: MouseEvent): Node | undefined {
  const p = toWorld(event);
  let best: Node | undefined;
  let bestD = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= radius(n) + 4 / view.scale && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

let drag: { x: number; y: number; moved: boolean } | undefined;

canvas.addEventListener('mousedown', (event) => {
  drag = { x: event.clientX, y: event.clientY, moved: false };
});
window.addEventListener('mouseup', (event) => {
  if (drag && !drag.moved) {
    const n = nodeAt(event);
    if (n) vscode.postMessage({ type: 'open', path: n.path });
  }
  drag = undefined;
});
canvas.addEventListener('mousemove', (event) => {
  if (drag) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) {
      view = { ...view, x: view.x + dx, y: view.y + dy };
      drag.x = event.clientX;
      drag.y = event.clientY;
    }
    return;
  }
  hover = nodeAt(event);
  canvas.style.cursor = hover ? 'pointer' : 'grab';
  canvas.title = hover ? hover.path : '';
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(6, Math.max(0.15, view.scale * factor));
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left - rect.width / 2;
    const my = event.clientY - rect.top - rect.height / 2;
    view = {
      scale,
      x: mx - ((mx - view.x) * scale) / view.scale,
      y: my - ((my - view.y) * scale) / view.scale,
    };
  },
  { passive: false },
);
filterInput.addEventListener('input', () => {
  filter = filterInput.value.trim().toLowerCase();
});

window.addEventListener('message', (event: MessageEvent<GraphToWebview | ToTips>) => {
  const message = event.data;
  if (message.type === 'graph') {
    if (message.current) current = message.current;
    load(message.graph);
  } else if (message.type === 'current') {
    current = message.path;
  }
});

vscode.postMessage({ type: 'ready' });
initCoach(vscode, 'vault');
