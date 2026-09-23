import { bundler } from "./bundler.js";
import { cargo } from "./cargo.js";
import { composer } from "./composer.js";
import { go } from "./go.js";
import { gradle } from "./gradle.js";
import { maven } from "./maven.js";
import { npm, pnpm, yarn } from "./node.js";
import { poetry, uv } from "./python.js";
/** Detection order matters: a repo may have a stray package-lock.json next to the real lockfile. */
export const adapters = [pnpm, yarn, npm, uv, poetry, cargo, go, composer, bundler, maven, gradle];
