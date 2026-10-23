/**
 * O gancho da economia como processo: o Claude Code o chama a cada evento
 * escutado com o JSON do evento na entrada. Roda pelo mesmo executável do
 * servidor MCP (`--gancho`). Nunca atrapalha a ferramenta: qualquer erro sai
 * calado, sem mudar nada.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localeFromEnv, useLocale } from '@fakl/i18n';

import { CoreClient } from '../rpc/client.js';
import { isModoEconomia } from './compactar.js';
import {
  estadoInicial,
  processarGancho,
  type EntradaDoGancho,
  type EstadoDoGancho,
  type SomasDoGancho,
} from './gancho.js';

async function lerEntrada(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let texto = '';
  for await (const parte of process.stdin) texto += parte as string;
  return texto;
}

function lerEstado(arquivo: string): EstadoDoGancho {
  try {
    const salvo = JSON.parse(readFileSync(arquivo, 'utf8')) as Partial<EstadoDoGancho>;
    return { ...estadoInicial(), ...salvo };
  } catch {
    return estadoInicial();
  }
}

const ANTIGO_MS = 2 * 24 * 60 * 60_000;

function limparAntigos(pasta: string): void {
  try {
    for (const nome of readdirSync(pasta)) {
      const arquivo = join(pasta, nome);
      if (Date.now() - statSync(arquivo).mtimeMs > ANTIGO_MS) rmSync(arquivo, { force: true });
    }
  } catch {
    // A pasta ainda não existe.
  }
}

async function registrar(somas: SomasDoGancho): Promise<void> {
  const socket = process.env.FAKL_CORE_SOCKET;
  const token = process.env.FAKL_AGENT_TOKEN;
  if (!socket || !token) return;
  const client = await CoreClient.connect(socket, token, 'agent');
  try {
    await client.request('economia.registrar', somas);
  } finally {
    client.close();
  }
}

export async function rodarGancho(): Promise<never> {
  try {
    useLocale(localeFromEnv(process.env));
    const modo = isModoEconomia(process.env.FAKL_ECONOMIA)
      ? process.env.FAKL_ECONOMIA
      : 'desligado';
    const explorador = process.env.FAKL_EXPLORADOR ?? '';
    const entrada = JSON.parse(await lerEntrada()) as EntradaDoGancho;
    const sessao = (entrada.session_id ?? 'sessao').replace(/[^\w-]/g, '_');
    const pasta = join(tmpdir(), 'fakl-economia');
    const arquivo = join(pasta, `${sessao}.json`);
    const estado = lerEstado(arquivo);
    const resultado = processarGancho(entrada, estado, {
      modo,
      ...(explorador ? { explorador } : {}),
    });
    if (entrada.hook_event_name === 'SessionEnd') rmSync(arquivo, { force: true });
    else {
      // Sessão parada pela IDE não chega ao SessionEnd: o que ficou de dias atrás sai aqui.
      if (entrada.hook_event_name === 'UserPromptSubmit') limparAntigos(pasta);
      mkdirSync(pasta, { recursive: true });
      writeFileSync(arquivo, JSON.stringify(estado));
    }
    if (resultado.saida !== undefined) process.stdout.write(JSON.stringify(resultado.saida));
    if (resultado.registrar) {
      await Promise.race([
        registrar(resultado.registrar),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
    }
  } catch {
    // Sem saída, o Claude Code segue com a ferramenta como ela respondeu.
  }
  process.exit(0);
}
