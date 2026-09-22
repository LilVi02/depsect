// JavaScript package managers. They share package.json semantics and differ
// only in the lockfile format and the install command.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBerry, npmLock, pnpmLock, yarnLock, type LockReader } from './lockfiles.ts';
import type { Adapter, Snapshot, Update } from './types.ts';

const MANIFEST = 'package.json';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
type Section = (typeof SECTIONS)[number];
type Manifest = Record<string, unknown> & Partial<Record<Section, Record<string, string>>>;

const parse = (text: string | null | undefined): Manifest | null => (text ? (JSON.parse(text) as Manifest) : null);

function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? m[0] : 2;
}

/** Find which section of the manifest declares `name`, if any. */
function sectionOf(man: Manifest | null, name: string): { section: Section; spec: string } | null {
  for (const s of SECTIONS) {
    const spec = man?.[s]?.[name];
    if (spec !== undefined) return { section: s, spec };
  }
  return null;
}

function directNames(...mans: (Manifest | null)[]): string[] {
  const names = new Set<string>();
  for (const man of mans) for (const s of SECTIONS) for (const n of Object.keys(man?.[s] ?? {})) names.add(n);
  return [...names].sort();
}

interface NodeAdapterSpec {
  name: string;
  lockfile: string;
  reader: LockReader;
  install: (head: Snapshot) => string;
}

function nodeAdapter({ name, lockfile, reader, install }: NodeAdapterSpec): Adapter {
  const resolved = (snap: Snapshot, dep: string, spec: string | undefined) => {
    const text = snap[lockfile];
    return text && spec !== undefined ? reader.direct(text, dep, spec) : undefined;
  };

  return {
    name,
    files: [MANIFEST, lockfile],
    installCommand: install,

    detect(head) {
      return head[MANIFEST] != null && head[lockfile] != null;
    },

    diff(base, head) {
      const bm = parse(base[MANIFEST]);
      const hm = parse(head[MANIFEST]);
      const updates: Update[] = [];
      for (const dep of directNames(bm, hm)) {
        const b = sectionOf(bm, dep);
        const h = sectionOf(hm, dep);
        const bv = resolved(base, dep, b?.spec);
        const hv = resolved(head, dep, h?.spec);
        const specChanged = b?.spec !== h?.spec || b?.section !== h?.section;
        if (!specChanged && bv === hv) continue;
        updates.push({
          id: dep,
          name: dep,
          section: (h ?? b)!.section,
          from: b ? (bv ?? b.spec) : null,
          to: h ? (hv ?? h.spec) : null,
        });
      }
      return updates;
    },

    notes(base, head) {
      const bl = base[lockfile];
      const hl = head[lockfile];
      if (!bl || !hl) return [];
      const direct = new Set(directNames(parse(base[MANIFEST]), parse(head[MANIFEST])));
      const b = reader.all(bl);
      const h = reader.all(hl);
      const same = (x?: Set<string>, y?: Set<string>) => x?.size === y?.size && [...(x ?? [])].every((v) => y?.has(v));
      let transitive = 0;
      for (const pkg of new Set([...b.keys(), ...h.keys()])) {
        if (!direct.has(pkg) && !same(b.get(pkg), h.get(pkg))) transitive++;
      }
      return transitive > 0
        ? [
            `${transitive} transitive package(s) changed in ${lockfile} as well. depsect bisects direct dependencies ` +
              `and lets ${name} re-resolve their subtrees, so transitive-only changes are not tested individually.`,
          ]
        : [];
    },

    async write(dir, base, head, subset) {
      const baseText = base[MANIFEST];
      if (!baseText) throw new Error(`${MANIFEST} does not exist at the base ref`);
      const man = parse(baseText)!;
      const hm = parse(head[MANIFEST]);

      for (const u of subset) {
        const b = sectionOf(man, u.name);
        const h = sectionOf(hm, u.name);
        if (b) delete man[b.section]![u.name];
        if (!h) continue; // removed in head

        // If only the lockfile moved (a range that already allowed the new
        // version), pin the exact version so the package manager installs it.
        const hv = resolved(head, u.name, h.spec);
        const spec = b && b.spec === h.spec && b.section === h.section && hv ? hv : h.spec;
        man[h.section] = { ...(man[h.section] ?? {}), [u.name]: spec };
      }

      await writeFile(join(dir, MANIFEST), JSON.stringify(man, null, detectIndent(baseText)) + '\n');
      const lock = base[lockfile];
      if (lock != null) await writeFile(join(dir, lockfile), lock);
    },
  };
}

export const npm = nodeAdapter({
  name: 'npm',
  lockfile: 'package-lock.json',
  reader: npmLock,
  install: () => 'npm install --no-audit --no-fund --loglevel=error',
});

export const pnpm = nodeAdapter({
  name: 'pnpm',
  lockfile: 'pnpm-lock.yaml',
  reader: pnpmLock,
  // pnpm freezes the lockfile under CI=true; depsect changes package.json on purpose.
  install: () => 'pnpm install --no-frozen-lockfile',
});

export const yarn = nodeAdapter({
  name: 'yarn',
  lockfile: 'yarn.lock',
  reader: yarnLock,
  install: (head) =>
    isBerry(head['yarn.lock'] ?? '')
      ? 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install'
      : 'yarn install --non-interactive --no-progress',
});
