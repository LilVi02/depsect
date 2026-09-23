// PHP: composer.json + composer.lock.
//
// composer.lock is a flat list of packages with one version each, like the
// Python lockfiles. A subset is applied by composing the lockfile: updated
// packages from head, the rest from base, plus whatever new packages the
// chosen ones require. composer.json comes from head with the constraints of
// packages outside the subset put back to base (composer install checks
// them), and the lock's content-hash is recomputed the way Composer does.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Snapshot, Update } from './types.ts';

const MANIFEST = 'composer.json';
const LOCKFILE = 'composer.lock';

interface Package {
  name: string;
  version: string;
  require?: Record<string, string>;
  [k: string]: unknown;
}

interface Lock {
  packages?: Package[];
  'packages-dev'?: Package[];
  [k: string]: unknown;
}

interface Manifest {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

/** php, ext-json, lib-icu, composer-plugin-api… are platform requirements, not packages. */
const isPlatform = (name: string) => !name.includes('/') || /^(php|ext-|lib-|composer(-|$))/.test(name);

const parse = <T>(text: string | null | undefined): T | null => (text ? (JSON.parse(text) as T) : null);

/** name → package and whether it is a dev package. */
function index(lock: Lock | null): Map<string, { pkg: Package; dev: boolean }> {
  const m = new Map<string, { pkg: Package; dev: boolean }>();
  for (const pkg of lock?.packages ?? []) m.set(pkg.name, { pkg, dev: false });
  for (const pkg of lock?.['packages-dev'] ?? []) m.set(pkg.name, { pkg, dev: true });
  return m;
}

/** PHP's json_encode with default flags: escaped slashes and \uXXXX for non-ASCII; empty objects become []. */
function phpJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') {
    return JSON.stringify(v).replace(/\//g, '\\/').replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  if (Array.isArray(v)) return `[${v.map(phpJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '[]';
  return `{${entries.map(([k, x]) => `${phpJson(k)}:${phpJson(x)}`).join(',')}}`;
}

/** composer.lock's content-hash for a composer.json (Composer's Locker::getContentHash). */
export function contentHash(manifestText: string): string {
  const content = JSON.parse(manifestText) as Record<string, unknown>;
  const keys = ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide', 'minimum-stability', 'prefer-stable', 'repositories', 'extra'];
  const relevant: Record<string, unknown> = {};
  for (const k of keys) if (k in content) relevant[k] = content[k];
  const platform = (content.config as { platform?: unknown } | undefined)?.platform;
  if (platform !== undefined) relevant.config = { platform };
  const sorted = Object.fromEntries(Object.keys(relevant).sort().map((k) => [k, relevant[k]]));
  return createHash('md5').update(phpJson(sorted)).digest('hex');
}

/** Put the constraints of `revert` packages in head's composer.json back to base's, editing only those strings. */
export function revertManifest(baseText: string, headText: string, revert: Set<string>): string {
  const b = parse<Manifest>(baseText) ?? {};
  const h = parse<Manifest>(headText) ?? {};
  let out = headText;
  for (const section of ['require', 'require-dev'] as const) {
    for (const name of revert) {
      const from = b[section]?.[name];
      const to = h[section]?.[name];
      if (from === undefined || to === undefined || from === to) continue;
      const esc = (x: string) => JSON.stringify(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(${esc(name)}\\s*:\\s*)${esc(to)}`), (_m, key: string) => key + JSON.stringify(from));
    }
  }
  return out;
}

/** Compose a lockfile: head's metadata, head's packages for `names`, base's for the rest, plus missing requirements. */
export function composeComposerLock(baseText: string, headText: string, names: Set<string>, headManifest: Manifest): string {
  const head = parse<Lock>(headText)!;
  const b = index(parse<Lock>(baseText));
  const h = index(head);
  const chosen = new Map<string, { pkg: Package; dev: boolean }>();
  for (const [name, entry] of b) if (!names.has(name)) chosen.set(name, entry);
  for (const name of names) if (h.has(name)) chosen.set(name, h.get(name)!);

  // Follow requirements, starting from the root's own (head's composer.json).
  const queue = [
    ...Object.keys(headManifest.require ?? {}),
    ...Object.keys(headManifest['require-dev'] ?? {}),
    ...[...chosen.values()].flatMap((e) => Object.keys(e.pkg.require ?? {})),
  ];
  while (queue.length) {
    const dep = queue.shift()!;
    if (isPlatform(dep) || chosen.has(dep)) continue;
    const add = h.get(dep) ?? b.get(dep);
    if (!add) continue;
    chosen.set(dep, add);
    queue.push(...Object.keys(add.pkg.require ?? {}));
  }

  const sorted = (dev: boolean) =>
    [...chosen.values()].filter((e) => e.dev === dev).map((e) => e.pkg).sort((x, y) => x.name.localeCompare(y.name));
  return JSON.stringify({ ...head, packages: sorted(false), 'packages-dev': sorted(true) }, null, 4) + '\n';
}

export const composer: Adapter = {
  name: 'composer',
  files: [MANIFEST, LOCKFILE],
  installCommand: () => 'composer install --no-interaction --no-progress',

  detect(head) {
    return head[MANIFEST] != null && head[LOCKFILE] != null;
  },

  diff(base, head) {
    const b = index(parse<Lock>(base[LOCKFILE]));
    const h = index(parse<Lock>(head[LOCKFILE]));
    const direct = new Map<string, string>();
    for (const man of [parse<Manifest>(base[MANIFEST]), parse<Manifest>(head[MANIFEST])]) {
      for (const n of Object.keys(man?.require ?? {})) if (!isPlatform(n)) direct.set(n, 'require');
      for (const n of Object.keys(man?.['require-dev'] ?? {})) if (!isPlatform(n)) direct.set(n, 'require-dev');
    }
    const updates: Update[] = [];
    for (const name of [...new Set([...b.keys(), ...h.keys()])].sort()) {
      const from = b.get(name)?.pkg.version;
      const to = h.get(name)?.pkg.version;
      // Packages that appear or disappear follow head's composer.json (or
      // the updates that need them), so only version changes are units.
      if (!from || !to || from === to) continue;
      const section = direct.get(name);
      updates.push({ id: name, name, section: section ?? 'lockfile', from, to, kind: section ? 'direct' : 'transitive' });
    }
    return { updates, excluded: [] };
  },

  async write(dir: string, base: Snapshot, head: Snapshot, subset: Update[]) {
    const headLock = head[LOCKFILE];
    if (!headLock) throw new Error(`${LOCKFILE} does not exist at the head ref`);
    // composer install checks the lock against composer.json, so packages
    // outside the subset get base's constraints back, and the lock's
    // content-hash is recomputed for the result.
    const chosen = new Set(subset.map((u) => u.name));
    const revert = new Set(this.diff(base, head).updates.map((u) => u.name).filter((n) => !chosen.has(n)));
    const manifestText = revertManifest(base[MANIFEST] ?? '{}', head[MANIFEST] ?? '{}', revert);
    const manifest = parse<Manifest>(manifestText) ?? {};
    const lock = JSON.parse(composeComposerLock(base[LOCKFILE] ?? '{}', headLock, chosen, manifest)) as Lock;
    if (typeof lock['content-hash'] === 'string') lock['content-hash'] = contentHash(manifestText);
    await writeFile(join(dir, MANIFEST), manifestText);
    await writeFile(join(dir, LOCKFILE), JSON.stringify(lock, null, 4) + '\n');
    return [];
  },
};
