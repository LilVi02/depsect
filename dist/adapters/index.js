import { npm, pnpm, yarn } from "./node.js";
/** Detection order matters: a repo may have a stray package-lock.json next to the real lockfile. */
export const adapters = [pnpm, yarn, npm];
