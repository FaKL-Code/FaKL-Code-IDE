import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Uma leitura de um processo filho: memória residente e tempo de CPU acumulado. */
export interface Amostra {
  /** Memória residente (working set no Windows), em bytes. */
  readonly rss: number;
  /** CPU de usuário mais sistema consumida desde o início do processo, em ms. */
  readonly cpuMs: number;
  /** Relógio de parede da leitura, em ms. */
  readonly em: number;
}

/**
 * Lê RSS e CPU de OUTRO processo pelo pid, sem dependência: /proc no Linux,
 * Get-Process no Windows e `ps` no macOS. O relógio vem junto da leitura para
 * o cálculo de CPU não depender da latência de iniciar o PowerShell.
 */
export async function amostrar(pid: number): Promise<Amostra> {
  if (process.platform === 'linux') {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1];
    // Depois do ")" do comm: estado(1) ... utime(12) stime(13), em ticks de 100 Hz.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const campos = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(campos[11]) + Number(campos[12]);
    return { rss: Number(kb) * 1024, cpuMs: ticks * 10, em: Date.now() };
  }
  if (process.platform === 'win32') {
    const script =
      `$p = Get-Process -Id ${pid}; $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ` +
      `"$($p.WorkingSet64) $($p.TotalProcessorTime.TotalMilliseconds) $t"`;
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const [rss, cpuMs, em] = stdout
      .trim()
      .split(/\s+/)
      .map((v) => Number(v.replace(',', '.')));
    return { rss: rss ?? NaN, cpuMs: cpuMs ?? NaN, em: em ?? NaN };
  }
  const { stdout } = await run('ps', ['-o', 'rss=', '-o', 'time=', '-p', String(pid)]);
  const [kb, tempo] = stdout.trim().split(/\s+/);
  // time= vem como [[dd-]hh:]mm:ss(.cc): resolução de centésimos no macOS.
  const partes = (tempo ?? '0').split(':').map(Number);
  let seg = 0;
  for (const p of partes) seg = seg * 60 + p;
  return { rss: Number(kb) * 1024, cpuMs: seg * 1000, em: Date.now() };
}

/** Percentual de uma CPU (100% = um núcleo inteiro) entre duas amostras. */
export function cpuPercent(a: Amostra, b: Amostra): number {
  return ((b.cpuMs - a.cpuMs) / (b.em - a.em)) * 100;
}

export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

export function percentil(valores: readonly number[], p: number): number {
  const ordenados = [...valores].sort((x, y) => x - y);
  return (
    ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)] ?? 0
  );
}

/**
 * Mostra a medida no log e, se FAKL_PERF_OUT apontar um arquivo, acrescenta uma
 * linha JSON a ele (o workflow semanal lê esse arquivo para o resumo do job).
 */
export function registrar(medida: Record<string, string | number>): void {
  const linha = JSON.stringify({ plataforma: process.platform, ...medida });
  console.log(`[perf] ${linha}`);
  const saida = process.env.FAKL_PERF_OUT;
  if (saida) appendFileSync(saida, `${linha}\n`);
}
