// Ruby: Gemfile + Gemfile.lock.
//
// A bundle holds one version of each gem (possibly in several platform
// builds). A subset is applied by starting from head and putting every gem
// outside the subset back to base: its spec entries (and any gems only base
// needs), its DEPENDENCIES line and checksums in Gemfile.lock, and its `gem`
// line in the Gemfile. The result is consistent, so `bundle install`
// installs it as-is.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Snapshot, Update } from './types.ts';

const MANIFEST = 'Gemfile';
const LOCKFILE = 'Gemfile.lock';

interface Spec {
  name: string;
  version: string;
  /** The spec line and its dependency lines, verbatim. */
  lines: string[];
  deps: string[];
}

interface Section {
  header: string;
  /** Lines before the specs (remote:, revision:, specs:), for sections that have specs. */
  preamble: string[];
  specs: Spec[];
  /** Verbatim body for sections without specs. */
  body: string[];
}

const SPEC = /^ {4}(\S+) \(([^)]+)\)$/;
const DEP = /^ {6}(\S+)/;
const ENTRY = /^ {2}(\S+?)!? ?(?:\(|$)/;

export function parseGemfileLock(text: string): Section[] {
  return text
    .trimEnd()
    .split(/\n\n+/)
    .map((chunk) => {
      const [header = '', ...rest] = chunk.split('\n');
      const section: Section = { header, preamble: [], specs: [], body: [] };
      if (!['GEM', 'PATH', 'GIT', 'PLUGIN SOURCE'].includes(header)) {
        section.body = rest;
        return section;
      }
      for (const line of rest) {
        const spec = SPEC.exec(line);
        if (spec) {
          // Platform builds look like "1.19.4-arm64-darwin"; gem versions never contain "-".
          section.specs.push({ name: spec[1]!, version: spec[2]!.split('-')[0]!, lines: [line], deps: [] });
          continue;
        }
        const dep = DEP.exec(line);
        const last = section.specs[section.specs.length - 1];
        if (dep && last) {
          last.lines.push(line);
          last.deps.push(dep[1]!);
        } else section.preamble.push(line);
      }
      return section;
    });
}

export function serializeGemfileLock(sections: Section[]): string {
  return (
    sections
      .map((s) => [s.header, ...s.preamble, ...s.specs.flatMap((x) => x.lines), ...s.body].join('\n'))
      .join('\n\n') + '\n'
  );
}

/** Versions of registry gems (GEM sections) by name. */
function gemVersions(sections: Section[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const s of sections.filter((x) => x.header === 'GEM')) {
    for (const spec of s.specs) (m.get(spec.name) ?? m.set(spec.name, new Set()).get(spec.name)!).add(spec.version);
  }
  return m;
}

/** Entries of a list section (DEPENDENCIES, CHECKSUMS), by gem name. */
function entries(sections: Section[], header: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of sections.find((s) => s.header === header)?.body ?? []) {
    const name = ENTRY.exec(line)?.[1];
    if (name) (m.get(name) ?? m.set(name, []).get(name)!).push(line);
  }
  return m;
}

const sameVersions = (a?: Set<string>, b?: Set<string>) => a?.size === b?.size && [...(a ?? [])].every((v) => b?.has(v));

/** Gems whose version changed between base and head (present on both sides). */
function changedGems(base: Section[], head: Section[]): string[] {
  const b = gemVersions(base);
  const h = gemVersions(head);
  return [...b.keys()].filter((n) => h.has(n) && !sameVersions(b.get(n), h.get(n))).sort();
}

/** Put `revert` gems back to their base state inside head's Gemfile.lock. */
export function revertGems(baseText: string, headText: string, revert: Set<string>): string {
  if (revert.size === 0) return headText;
  const base = parseGemfileLock(baseText);
  const head = parseGemfileLock(headText);
  const baseSpecs = new Map<string, Spec[]>();
  for (const s of base.filter((x) => x.header === 'GEM')) for (const spec of s.specs) (baseSpecs.get(spec.name) ?? baseSpecs.set(spec.name, []).get(spec.name)!).push(spec);

  const gem = head.find((s) => s.header === 'GEM');
  if (gem) {
    const have = () => new Set(head.flatMap((s) => s.specs.map((x) => x.name)));
    for (const s of head.filter((x) => x.header === 'GEM')) s.specs = s.specs.filter((x) => !revert.has(x.name));
    const queue = [...revert];
    while (queue.length) {
      const name = queue.shift()!;
      if (have().has(name)) continue;
      const add = baseSpecs.get(name);
      if (!add) continue;
      gem.specs.push(...add);
      // Anything the base version needs that head no longer has.
      queue.push(...add.flatMap((x) => x.deps));
    }
    gem.specs.sort((x, y) => x.name.localeCompare(y.name));
  }

  for (const header of ['DEPENDENCIES', 'CHECKSUMS']) {
    const section = head.find((s) => s.header === header);
    if (!section) continue;
    const from = entries(base, header);
    const kept = section.body.filter((l) => !revert.has(ENTRY.exec(l)?.[1] ?? ''));
    const restored = [...revert].flatMap((n) => from.get(n) ?? (header === 'DEPENDENCIES' ? entries(head, header).get(n) ?? [] : []));
    section.body = [...kept, ...restored].sort((x, y) => (ENTRY.exec(x)?.[1] ?? x).localeCompare(ENTRY.exec(y)?.[1] ?? y));
  }
  return serializeGemfileLock(head);
}

/** Put `revert` gems' `gem "name", ...` lines in the Gemfile back to base. */
export function revertGemfile(baseText: string, headText: string, revert: Set<string>): string {
  const lineOf = (text: string, name: string) =>
    text.split('\n').find((l) => new RegExp(`^\\s*gem\\s*\\(?\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(l));
  let out = headText;
  for (const name of revert) {
    const b = lineOf(baseText, name);
    const h = lineOf(out, name);
    if (b && h && b !== h) out = out.split('\n').map((l) => (l === h ? b : l)).join('\n');
  }
  return out;
}

export const bundler: Adapter = {
  name: 'bundler',
  files: [MANIFEST, LOCKFILE],
  installCommand: () => 'bundle install',
  // The composed Gemfile.lock is consistent, but a frozen bundle refuses any lockfile it did not write.
  env: { BUNDLE_FROZEN: 'false' },

  detect(head) {
    return head[MANIFEST] != null && head[LOCKFILE] != null;
  },

  diff(base, head) {
    const b = parseGemfileLock(base[LOCKFILE] ?? '');
    const h = parseGemfileLock(head[LOCKFILE] ?? '');
    const bv = gemVersions(b);
    const hv = gemVersions(h);
    const direct = new Set([...entries(b, 'DEPENDENCIES').keys(), ...entries(h, 'DEPENDENCIES').keys()]);
    const show = (s: Set<string>) => [...s].sort().join(', ');
    const updates: Update[] = changedGems(b, h).map((name) => ({
      id: name,
      name,
      section: direct.has(name) ? 'Gemfile' : 'lockfile',
      from: show(bv.get(name)!),
      to: show(hv.get(name)!),
      kind: direct.has(name) ? 'direct' : 'transitive',
    }));
    return { updates, excluded: [] };
  },

  async write(dir: string, base: Snapshot, head: Snapshot, subset: Update[]) {
    const baseLock = base[LOCKFILE] ?? '';
    const headLock = head[LOCKFILE];
    if (!headLock) throw new Error(`${LOCKFILE} does not exist at the head ref`);
    const chosen = new Set(subset.map((u) => u.name));
    const revert = new Set(changedGems(parseGemfileLock(baseLock), parseGemfileLock(headLock)).filter((n) => !chosen.has(n)));
    await writeFile(join(dir, MANIFEST), revertGemfile(base[MANIFEST] ?? '', head[MANIFEST] ?? '', revert));
    await writeFile(join(dir, LOCKFILE), revertGems(baseLock, headLock, revert));
    return [];
  },
};
