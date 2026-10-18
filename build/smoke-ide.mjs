#!/usr/bin/env node
// Teste de fumaça da IDE compilada (RNF-02, RF-109 e a regressão do MCP).
//
// Abre o build de verdade, isolado (pasta de dados, HOME e socket do Core próprios) e
// confere o que um teste de unidade não vê: a janela sobe, o FaKL Core publica o
// endereço, a extensão ativa sem erro, o servidor MCP `fakl` responde (o Doctor usa a
// mesma sonda) e a CLI `fakl` abre. Existe porque os bundles ESM do MCP e da CLI
// morreram ao iniciar de v0.1.0 a v0.1.3 sem que nada acusasse.
//
// Uso: node build/smoke-ide.mjs --exe <caminho do executável> [--baseline-exe <VSCodium>]
//        [--resumo <arquivo.md>]
// Requer `pnpm build` (usa o cliente do Core em packages/core/dist).

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PORTA_BASE = 9340;
/** Tempo máximo para a janela e para o Core subirem em runner compartilhado. */
const LIMITE_MS = 120_000;
/** A IDE pode abrir até 2x mais devagar que o VSCodium (folga: o SDD pede 20%, runner oscila). */
const FATOR_DO_BASELINE = 2;
const FOLGA_MS = 5_000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function argumentos() {
  const args = process.argv.slice(2);
  const pegar = (nome) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const exe = pegar('--exe');
  if (!exe) {
    console.error(
      'uso: smoke-ide.mjs --exe <executável> [--baseline-exe <VSCodium>] [--resumo <md>]',
    );
    process.exit(2);
  }
  return {
    exe: resolve(exe),
    baseline: pegar('--baseline-exe'),
    resumo: pegar('--resumo') ?? process.env.GITHUB_STEP_SUMMARY,
  };
}

/** Pasta `resources/app` do build (o macOS guarda em Contents/Resources). */
function pastaDoApp(exe) {
  const candidatos = [
    join(dirname(exe), 'resources', 'app'),
    join(dirname(exe), '..', 'Resources', 'app'),
  ];
  const achada = candidatos.find((c) => existsSync(join(c, 'package.json')));
  if (!achada) throw new Error(`não achei resources/app ao lado de ${exe}`);
  return achada;
}

function matar(filho) {
  if (!filho.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-filho.pid, 'SIGKILL');
    } catch {
      filho.kill('SIGKILL');
    }
  }
}

async function janelaDoWorkbench(porta, inicio) {
  while (Date.now() - inicio < LIMITE_MS) {
    try {
      const lista = await (await fetch(`http://127.0.0.1:${porta}/json`)).json();
      if (lista.some((p) => p.type === 'page' && /workbench\.html/.test(p.url)))
        return Date.now() - inicio;
    } catch {
      // ainda subindo
    }
    await dormir(500);
  }
  throw new Error('a janela da IDE não abriu no tempo limite');
}

function abrir(exe, rotulo, porta) {
  const raiz = mkdtempSync(join(tmpdir(), `fakl-smoke-${rotulo}-`));
  const casa = join(raiz, 'casa');
  const dados = join(raiz, 'dados');
  mkdirSync(join(dados, 'User'), { recursive: true });
  mkdirSync(casa, { recursive: true });
  writeFileSync(
    join(dados, 'User', 'settings.json'),
    JSON.stringify({
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
      'update.mode': 'none',
    }),
  );
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\fakl-smoke-${process.pid}-${rotulo}`
      : join(raiz, 'core.sock');
  const args = [
    '--user-data-dir',
    dados,
    '--extensions-dir',
    join(raiz, 'ext'),
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--new-window',
    `--remote-debugging-port=${porta}`,
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');
  const inicio = Date.now();
  const filho = spawn(exe, args, {
    env: { ...process.env, USERPROFILE: casa, HOME: casa, FAKL_CORE_SOCKET: socket },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: false,
  });
  return { raiz, casa, dados, filho, inicio };
}

function logsComErro(dados) {
  const achados = [];
  const visitar = (pasta) => {
    for (const nome of readdirSync(pasta, { withFileTypes: true })) {
      const caminho = join(pasta, nome.name);
      if (nome.isDirectory()) visitar(caminho);
      else if (/\.log$/.test(nome.name)) {
        for (const linha of readFileSync(caminho, 'utf8').split('\n')) {
          if (
            /Activating extension .*fakl.*failed|Cannot activate the '.*fakl|Uncaught Exception|Dynamic require/i.test(
              linha,
            )
          )
            achados.push(linha.slice(0, 200));
        }
      }
    }
  };
  if (existsSync(join(dados, 'logs'))) visitar(join(dados, 'logs'));
  return achados;
}

async function conferirCore(sessao) {
  const dist = pathToFileURL(resolve(AQUI, '..', 'packages', 'core', 'dist', 'index.js')).href;
  const { CoreClient, coreInfoPath, readCoreInfo } = await import(dist);
  const inicio = Date.now();
  while (Date.now() - inicio < LIMITE_MS) {
    const info = await readCoreInfo(coreInfoPath(sessao.casa)).catch(() => undefined);
    if (info) {
      const tempo = Date.now() - sessao.inicio;
      const cliente = await CoreClient.connect(info.socketPath, info.token, 'extension');
      try {
        const ambiente = await cliente.request('providers.environment', {});
        return { tempo, mcp: ambiente.mcp, versao: cliente.hello?.coreVersion };
      } finally {
        cliente.close();
      }
    }
    await dormir(500);
  }
  throw new Error('o FaKL Core não publicou o endereço no tempo limite');
}

function conferirExecutaveis(exe) {
  const app = pastaDoApp(exe);
  const dist = join(app, 'extensions', 'fakl-core', 'dist');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const cli = spawnSync(exe, [join(dist, 'fakl.mjs'), '--help'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const mcp = spawnSync(exe, [join(dist, 'mcp.mjs')], {
    env: {
      ...env,
      FAKL_CORE_SOCKET: 'inexistente',
      FAKL_AGENT_TOKEN: 'teste',
      FAKL_MCP_TOOLS: 'maestro',
    },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fumaca', version: '0' } } })}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  });
  let servidor;
  try {
    servidor = JSON.parse((mcp.stdout ?? '').split('\n')[0] ?? '{}').result?.serverInfo?.name;
  } catch {
    servidor = undefined;
  }
  return {
    cli: cli.status === 0 && /fakl/.test(cli.stdout ?? ''),
    mcp: servidor === 'fakl',
    // A linha do erro vem depois de um trecho minificado enorme do bundle: só a mensagem importa.
    erros: [cli.stderr, mcp.stderr]
      .map((t) =>
        (t ?? '')
          .split(/\r?\n/)
          .find((l) => /^[A-Za-z]*Error: .*(Dynamic require|Cannot find module)/.test(l)),
      )
      .filter((l) => l !== undefined)
      .map((l) => l.slice(0, 200)),
  };
}

async function medirBaseline(exe) {
  const sessao = abrir(exe, 'base', PORTA_BASE + 1);
  try {
    return await janelaDoWorkbench(PORTA_BASE + 1, sessao.inicio);
  } finally {
    matar(sessao.filho);
    await dormir(1500);
    rmSync(sessao.raiz, { recursive: true, force: true });
  }
}

const { exe, baseline, resumo } = argumentos();
const falhas = [];
const linhas = [];
const nota = (texto) => {
  console.log(texto);
  linhas.push(texto);
};

const sessao = abrir(exe, 'fakl', PORTA_BASE);
try {
  const janela = await janelaDoWorkbench(PORTA_BASE, sessao.inicio);
  nota(`- Janela aberta em ${(janela / 1000).toFixed(1)} s`);
  const core = await conferirCore(sessao);
  nota(
    `- FaKL Core ${core.versao ?? ''} publicou o endereço em ${(core.tempo / 1000).toFixed(1)} s`,
  );
  if (core.mcp?.ok === true)
    nota(`- Servidor MCP da FaKL: ok (${core.mcp.ferramentas ?? '?'} ferramentas)`);
  else falhas.push(`servidor MCP da FaKL não respondeu: ${JSON.stringify(core.mcp)}`);
  await dormir(8_000);
  const erros = logsComErro(sessao.dados);
  if (erros.length > 0) falhas.push(`erros nos logs:\n  ${erros.join('\n  ')}`);
  else nota('- Logs sem erro de ativação');
  if (baseline) {
    const base = await medirBaseline(resolve(baseline)).catch((e) => {
      nota(`- Baseline do VSCodium indisponível: ${e.message}`);
      return undefined;
    });
    if (base !== undefined) {
      nota(
        `- VSCodium (baseline) abriu em ${(base / 1000).toFixed(1)} s; a FaKL em ${(janela / 1000).toFixed(1)} s`,
      );
      if (janela > base * FATOR_DO_BASELINE + FOLGA_MS)
        falhas.push(
          `abertura ${(janela / 1000).toFixed(1)} s contra ${(base / 1000).toFixed(1)} s do VSCodium`,
        );
    }
  }
} catch (erro) {
  falhas.push(erro.message);
} finally {
  matar(sessao.filho);
  await dormir(1500);
  rmSync(sessao.raiz, { recursive: true, force: true });
}

try {
  const exec = conferirExecutaveis(exe);
  if (exec.cli) nota('- CLI fakl: abre');
  else falhas.push('a CLI fakl não abriu');
  if (exec.mcp) nota('- Servidor MCP direto: responde ao initialize');
  else falhas.push('o servidor MCP direto não respondeu ao initialize');
  if (exec.erros.length > 0) falhas.push(`erro de módulo:\n  ${exec.erros.join('\n  ')}`);
} catch (erro) {
  falhas.push(erro.message);
}

const titulo = falhas.length === 0 ? '### Fumaça da IDE: passou' : '### Fumaça da IDE: FALHOU';
const texto = `${titulo}\n\n${linhas.join('\n')}\n${falhas.map((f) => `- FALHA: ${f}`).join('\n')}\n`;
if (resumo) appendFileSync(resumo, `${texto}\n`);
if (falhas.length > 0) {
  console.error(falhas.join('\n'));
  process.exit(1);
}
console.log('fumaça ok');
