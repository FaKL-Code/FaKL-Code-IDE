// Lista, no formato do GITHUB_OUTPUT, as pastas de dependências do Code-OSS
// que valem cache e a chave delas. Roda depois do build/fetch.sh.
//
// As pastas vêm do próprio Code-OSS (build/npm/dirs.ts), e a chave cobre tudo o
// que muda o resultado da instalação: os package.json e package-lock.json, os
// patches do VSCodium (alguns mexem em dependências), a versão do Node e o
// sistema e a arquitetura alvo.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const vscodium = resolve(root, process.env.FAKL_BUILD_DIR ?? '.build', 'vscodium');
const vscode = join(vscodium, 'vscode');

const { dirs } = await import(pathToFileURL(join(vscode, 'build/npm/dirs.ts')).href);

const hash = createHash('sha256');
hash.update(`${process.version}\n${process.env.OS_NAME}\n${process.env.VSCODE_ARCH}\n`);

const paths = [];
for (const dir of dirs) {
  const base = join(vscode, dir);
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
    const path = join(base, file);
    if (existsSync(path)) {
      hash.update(`${relative(vscode, path)}\n`);
      hash.update(readFileSync(path));
    }
  }
  paths.push(relative(root, join(base, 'node_modules')));
}
paths.push(relative(root, join(vscode, '.build', 'builtInExtensions')));

const patches = join(vscodium, 'patches');
for (const entry of readdirSync(patches, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name);
    hash.update(`${relative(vscodium, path)}\n`);
    hash.update(readFileSync(path));
  }
}

const prefix = `deps-${process.env.OS_NAME}-${process.env.VSCODE_ARCH}-`;
const toPosix = (path) => path.split('\\').join('/');

console.log(`key=${prefix}${hash.digest('hex').slice(0, 32)}`);
console.log(`restore-key=${prefix}`);
console.log('paths<<EOF');
for (const path of paths) console.log(toPosix(path));
console.log('EOF');
