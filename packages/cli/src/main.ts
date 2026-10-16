#!/usr/bin/env node
import { homedir } from 'node:os';

import { CoreClient, CoreRpcError, coreInfoPath, readCoreInfo } from '@fakl/core';
import { l10n, localeFromEnv, useLocale } from '@fakl/i18n';

import { runCli } from './cli.js';

// Antes de qualquer texto: o idioma do terminal (FAKL_LOCALE, LC_ALL, LANG...).
useLocale(localeFromEnv(process.env));

let client: CoreClient | undefined;

async function core(): Promise<CoreClient> {
  const info = await readCoreInfo(coreInfoPath(homedir()));
  if (!info) throw new Error(l10n.t('FaKL Core is not running; open the FaKL-Code IDE'));
  client = await CoreClient.connect(info.socketPath, info.token, 'cli');
  return client;
}

try {
  process.exitCode = await runCli(process.argv.slice(2), core, {
    out: (line) => process.stdout.write(`${line}\n`),
    cwd: process.cwd(),
    stdin: async () => {
      let text = '';
      for await (const chunk of process.stdin) text += String(chunk);
      return text;
    },
  });
} catch (error) {
  const text =
    error instanceof CoreRpcError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`fakl: ${text}\n`);
  process.exitCode = 1;
} finally {
  client?.close();
}
