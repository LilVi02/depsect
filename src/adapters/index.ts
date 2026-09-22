import { npm, pnpm, yarn } from './node.ts';
import type { Adapter } from './types.ts';

/** Detection order matters: a repo may have a stray package-lock.json next to the real lockfile. */
export const adapters: Adapter[] = [pnpm, yarn, npm];
