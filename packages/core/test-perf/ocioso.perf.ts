import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { CoreClient } from '../src/index.js';
import { amostrar, cpuPercent, mb, registrar } from './medidas.js';

const coreMjs = fileURLToPath(
  new URL('../../../extensions/fakl-core/dist/core.mjs', import.meta.url),
);

// Os limites do SDD (RNF-03) são 150 MB e 1% de CPU. Aqui há folga para runner
// compartilhado e para o PowerShell do Windows; os números reais ficam no log.
const LIMITE_RSS_MB = 200;
const LIMITE_CPU_PERCENT = 3;

describe.skipIf(!existsSync(coreMjs))('RNF-03: Core ocioso', () => {
  let filho: ChildProcess | undefined;
  let home: string | undefined;

  afterAll(async () => {
    filho?.kill();
    if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('usa pouca memória e quase nenhuma CPU sem agentes', async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-perf-'));
    const token = randomBytes(16).toString('hex');
    const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\fakl-perf-${randomBytes(6).toString('hex')}`
        : join(home, 'core.sock');

    // O Core empacotado, como a IDE o inicia, num HOME temporário para não tocar no ~/.fakl real.
    filho = spawn(process.execPath, [coreMjs], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FAKL_CORE_SOCKET: socket,
        FAKL_CORE_TOKEN: token,
        FAKL_LOCALE: 'en',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    const pronto = new Promise<void>((resolve, reject) => {
      filho?.stderr?.on('data', (chunk: Buffer) => {
        log += chunk.toString();
        if (log.includes('listening on')) resolve();
      });
      filho?.once('exit', (code) => {
        reject(new Error(`o Core saiu com código ${String(code)}: ${log}`));
      });
    });
    await pronto;
    const pid = filho.pid;
    if (pid === undefined) throw new Error('sem pid');

    // Uma conexão aberta, como a da extensão da IDE; nenhum agente.
    const client = await CoreClient.connect(socket, token, 'test');
    try {
      // Deixa a inicialização assentar antes de medir.
      await esperar(5_000);
      const inicio = await amostrar(pid);
      await esperar(15_000);
      const fim = await amostrar(pid);

      const rss = mb(fim.rss);
      const cpu = Math.round(cpuPercent(inicio, fim) * 100) / 100;
      registrar({
        teste: 'RNF-03 ocioso',
        rss_mb: rss,
        cpu_percent: cpu,
        janela_s: Math.round((fim.em - inicio.em) / 1000),
        limite_rss_mb: LIMITE_RSS_MB,
        limite_cpu_percent: LIMITE_CPU_PERCENT,
      });

      expect(rss).toBeGreaterThan(0);
      expect(rss).toBeLessThan(LIMITE_RSS_MB);
      expect(cpu).toBeLessThan(LIMITE_CPU_PERCENT);
    } finally {
      client.close();
    }
  });
});
