// Build tools without a lockfile (Maven, Gradle) keep versions as literals
// inside build files: a <version> element, a property, a version catalog
// entry, a "group:artifact:version" string. Each such place is a "site" with
// a stable key. A subset is applied by starting from head's files and putting
// every changed site outside the subset back to its base value, so added and
// removed declarations always follow head.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Snapshot, Update } from './types.ts';

export interface Site {
  /** Stable identity across base and head, e.g. "dependency:org.slf4j:slf4j-api#0". */
  key: string;
  /** Human-readable name for reports, e.g. "org.slf4j:slf4j-api". */
  name: string;
  /** Where it is declared, e.g. "dependency", "property", "catalog". */
  section: string;
  value: string;
  /** Offsets of `value` in the file. */
  start: number;
  end: number;
}

export interface SiteSpec {
  name: string;
  /** Files read at the project root. */
  files: string[];
  detect(head: Snapshot): boolean;
  /** Other build files of the project (modules, subprojects, catalogs). */
  members(snap: Snapshot, paths: string[]): string[];
  /** Does this adapter scan `path` for sites? */
  scans(path: string): boolean;
  sites(path: string, text: string): Site[];
  /** Nicer names once every file is known, e.g. a property → the artifact that uses it. */
  rename?(key: string, files: Record<string, string>): string | undefined;
  install: string;
}

/** Same length as `text`, with the ranges matched by `re` blanked, so offsets stay valid. */
export function mask(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

/** Number repeated keys in order of appearance ("#0", "#1", …) so each site is unique. */
export function numbered(sites: Omit<Site, 'key'>[], keyOf: (s: Omit<Site, 'key'>) => string): Site[] {
  const seen = new Map<string, number>();
  return sites.map((s) => {
    const base = keyOf(s);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...s, key: `${base}#${n}` };
  });
}

export function siteAdapter(spec: SiteSpec): Adapter {
  const scanned = (snap: Snapshot) => Object.keys(snap).filter((k) => snap[k] != null && spec.scans(k));

  /** Changed sites: key → base/head values and where they are. */
  const changes = (base: Snapshot, head: Snapshot) => {
    const out = new Map<string, { name: string; section: string; from: Set<string>; to: Set<string> }>();
    for (const file of [...new Set([...scanned(base), ...scanned(head)])].sort()) {
      const b = new Map(spec.sites(file, base[file] ?? '').map((s) => [s.key, s]));
      for (const h of spec.sites(file, head[file] ?? '')) {
        const bs = b.get(h.key);
        if (!bs || bs.value === h.value) continue;
        const c = out.get(h.key) ?? { name: h.name, section: h.section, from: new Set(), to: new Set() };
        c.from.add(bs.value);
        c.to.add(h.value);
        out.set(h.key, c);
      }
    }
    return out;
  };

  return {
    name: spec.name,
    files: spec.files,
    members: spec.members,
    detect: spec.detect,
    installCommand: () => spec.install,

    diff(base, head) {
      const files = Object.fromEntries(scanned(head).map((f) => [f, head[f]!]));
      const updates: Update[] = [...changes(base, head)].map(([key, c]) => ({
        id: key,
        name: spec.rename?.(key, files) ?? c.name,
        section: c.section,
        from: [...c.from].sort().join(', '),
        to: [...c.to].sort().join(', '),
        kind: 'direct',
      }));
      updates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { updates, excluded: [] };
    },

    async write(dir, base, head, subset) {
      const chosen = new Set(subset.map((u) => u.id));
      const revert = new Set([...changes(base, head).keys()].filter((k) => !chosen.has(k)));
      for (const file of scanned(head)) {
        const text = head[file]!;
        const baseSites = new Map(spec.sites(file, base[file] ?? '').map((s) => [s.key, s]));
        // Replace from the end so earlier offsets stay valid.
        const edits = spec
          .sites(file, text)
          .filter((s) => revert.has(s.key) && baseSites.has(s.key))
          .sort((a, b) => b.start - a.start);
        let out = text;
        for (const s of edits) out = out.slice(0, s.start) + baseSites.get(s.key)!.value + out.slice(s.end);
        await writeFile(join(dir, file), out);
      }
      return [];
    },
  };
}
