// Monta out/fakl-relay/: o que vai para o VPS (SDD 12.1). Rode depois do build
// do PWA: `pnpm --filter @fakl/remote-pwa build && pnpm --filter @fakl/relay pack:relay`.
import { cp, mkdir, rm } from 'node:fs/promises';

const out = 'out/fakl-relay';
await rm('out', { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('bundle/relay.mjs', `${out}/relay.mjs`);
await cp('../../apps/remote-pwa/dist', `${out}/public`, { recursive: true });
await cp('deploy', out, { recursive: true });
process.stdout.write(`pronto: ${out}\n`);
