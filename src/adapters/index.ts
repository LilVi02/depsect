import { bundler } from './bundler.ts';
import { cargo } from './cargo.ts';
import { composer } from './composer.ts';
import { go } from './go.ts';
import { gradle } from './gradle.ts';
import { maven } from './maven.ts';
import { npm, pnpm, yarn } from './node.ts';
import { poetry, uv } from './python.ts';
import type { Adapter } from './types.ts';

/** Detection order matters: a repo may have a stray package-lock.json next to the real lockfile. */
export const adapters: Adapter[] = [pnpm, yarn, npm, uv, poetry, cargo, go, composer, bundler, maven, gradle];
