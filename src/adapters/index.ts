import { cargo } from './cargo.ts';
import { go } from './go.ts';
import { npm, pnpm, yarn } from './node.ts';
import { poetry, uv } from './python.ts';
import type { Adapter } from './types.ts';

/** Detection order matters: a repo may have a stray package-lock.json next to the real lockfile. */
export const adapters: Adapter[] = [pnpm, yarn, npm, uv, poetry, cargo, go];
