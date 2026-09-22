// Python: uv (uv.lock) and Poetry (poetry.lock).
//
// A Python environment holds one version of each package, and both lockfiles
// are flat lists of `[[package]]` blocks. So a subset is applied by composing
// a lockfile: blocks for updated packages come from head, everything else from
// base, plus whatever new packages the updated versions need. The project's
// own pyproject.toml and lock metadata come from head, and the tool installs
// the composed lockfile as-is (`uv sync --frozen`, `poetry sync`).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseToml, type TomlTable, type TomlValue } from '../toml.ts';
import { sameSet, showVersions, type Adapter, type Snapshot, type Update } from './types.ts';

const PYPROJECT = 'pyproject.toml';

/** PEP 503 name normalization. */
export const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** Name part of a PEP 508 requirement like "requests[socks] (>=2.31) ; python_version > '3.8'". */
const requirementName = (req: string) => normalize(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? req);

export interface Block {
  name: string;
  version: string;
  text: string;
  deps: string[];
  /** The project itself (or a workspace member), which always comes from head. */
  root: boolean;
}

export interface FlatLock {
  header: string;
  blocks: Block[];
  footer: string;
}

const table = (v: TomlValue | undefined): TomlTable => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const array = (v: TomlValue | undefined): TomlValue[] => (Array.isArray(v) ? v : []);

/** Names referenced as `{ name = "x" }` anywhere in a uv dependency list or table of lists. */
function uvDepNames(v: TomlValue | undefined): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof table(x).name === 'string' ? [normalize(table(x).name as string)] : []));
  return Object.values(table(v)).flatMap(uvDepNames);
}

export function parseFlatLock(text: string, flavor: 'uv' | 'poetry'): FlatLock {
  const lines = text.split('\n');
  const starts: number[] = [];
  let footerAt = lines.length;
  lines.forEach((l, i) => {
    if (l.trim() === '[[package]]') starts.push(i);
    else if (flavor === 'poetry' && l.trim() === '[metadata]') footerAt = i;
  });
  const header = lines.slice(0, starts[0] ?? footerAt).join('\n');
  const footer = lines.slice(footerAt).join('\n');
  const blocks = starts.map((s, i) => {
    const blockText = lines.slice(s, starts[i + 1] ?? footerAt).join('\n');
    const pkg = table(array(parseToml(blockText).package)[0]);
    const name = normalize(String(pkg.name));
    const source = table(pkg.source);
    const deps =
      flavor === 'uv'
        ? [...uvDepNames(pkg.dependencies), ...uvDepNames(pkg['optional-dependencies']), ...uvDepNames(pkg['dev-dependencies'])]
        : Object.keys(table(pkg.dependencies)).map(normalize);
    const root = flavor === 'uv' && ('virtual' in source || 'editable' in source);
    return { name, version: String(pkg.version), text: blockText.replace(/\n+$/, ''), deps: [...new Set(deps)], root };
  });
  return { header, blocks, footer };
}

const versionsByName = (lock: FlatLock) => {
  const m = new Map<string, Set<string>>();
  for (const b of lock.blocks) if (!b.root) (m.get(b.name) ?? m.set(b.name, new Set()).get(b.name)!).add(b.version);
  return m;
};

/**
 * Compose a lockfile: head's root blocks, head's blocks for `names`, base's
 * blocks for everything else, plus (transitively) any package a chosen block
 * depends on that is missing, taken from head if head has it, else from base.
 */
export function composeFlatLock(base: FlatLock, head: FlatLock, names: Set<string>, separator: string): string {
  const byName = (lock: FlatLock) => {
    const m = new Map<string, Block[]>();
    for (const b of lock.blocks) if (!b.root) (m.get(b.name) ?? m.set(b.name, []).get(b.name)!).push(b);
    return m;
  };
  const b = byName(base);
  const h = byName(head);
  const chosen = new Map<string, Block[]>();
  for (const [name, blocks] of b) if (!names.has(name)) chosen.set(name, blocks);
  for (const name of names) if (h.has(name)) chosen.set(name, h.get(name)!);

  const roots = head.blocks.filter((x) => x.root);
  const queue = [...roots, ...[...chosen.values()].flat()];
  while (queue.length) {
    for (const dep of queue.shift()!.deps) {
      if (chosen.has(dep) || roots.some((r) => r.name === dep)) continue;
      const add = h.get(dep) ?? b.get(dep);
      if (!add) continue;
      chosen.set(dep, add);
      queue.push(...add);
    }
  }

  const blocks = [...roots, ...[...chosen.values()].flat()].sort(
    (x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version, undefined, { numeric: true }),
  );
  return [head.header.replace(/\n+$/, ''), ...blocks.map((x) => x.text), head.footer.replace(/\n+$/, '')]
    .filter((s) => s !== '')
    .join(separator) + '\n';
}

interface PythonSpec {
  name: string;
  lockfile: string;
  flavor: 'uv' | 'poetry';
  install: string;
  /** Normalized names of direct dependencies, and the group each is declared in. */
  direct(pyproject: TomlTable, lock: FlatLock): Map<string, string>;
}

function pythonAdapter(spec: PythonSpec): Adapter {
  const read = (snap: Snapshot) => {
    const lockText = snap[spec.lockfile];
    if (!lockText) return null;
    const lock = parseFlatLock(lockText, spec.flavor);
    const pyproject = snap[PYPROJECT] ? parseToml(snap[PYPROJECT]!) : {};
    return { lock, direct: spec.direct(pyproject, lock) };
  };

  return {
    name: spec.name,
    files: [PYPROJECT, spec.lockfile],
    installCommand: () => spec.install,

    detect(head) {
      return head[PYPROJECT] != null && head[spec.lockfile] != null;
    },

    diff(base, head) {
      const b = read(base);
      const h = read(head);
      if (!h) return { updates: [], excluded: [] };
      const bv = b ? versionsByName(b.lock) : new Map<string, Set<string>>();
      const hv = versionsByName(h.lock);
      const updates: Update[] = [];
      for (const name of [...new Set([...bv.keys(), ...hv.keys()])].sort()) {
        const from = bv.get(name);
        const to = hv.get(name);
        if (sameSet(from, to)) continue;
        // Packages that appear or disappear follow head's pyproject.toml (or
        // the updates that need them), so only version changes are units.
        if (!from || !to) continue;
        const group = h.direct.get(name) ?? b?.direct.get(name);
        updates.push({
          id: name,
          name,
          section: group ?? 'lockfile',
          from: showVersions(from),
          to: showVersions(to),
          kind: group ? 'direct' : 'transitive',
        });
      }
      return { updates, excluded: [] };
    },

    async write(dir, base, head, subset) {
      const baseLock = base[spec.lockfile];
      const headLock = head[spec.lockfile];
      if (!headLock) throw new Error(`${spec.lockfile} does not exist at the head ref`);
      const composed = composeFlatLock(
        parseFlatLock(baseLock ?? '', spec.flavor),
        parseFlatLock(headLock, spec.flavor),
        new Set(subset.map((u) => u.name)),
        '\n\n',
      );
      await writeFile(join(dir, PYPROJECT), head[PYPROJECT] ?? '');
      await writeFile(join(dir, spec.lockfile), composed);
      return [];
    },
  };
}

export const uv = pythonAdapter({
  name: 'uv',
  lockfile: 'uv.lock',
  flavor: 'uv',
  install: 'uv sync --frozen',
  direct(_pyproject, lock) {
    // uv records the project's direct dependencies on its own lock entry.
    const out = new Map<string, string>();
    for (const root of lock.blocks.filter((b) => b.root)) {
      const pkg = table(array(parseToml(root.text).package)[0]);
      for (const n of uvDepNames(pkg.dependencies)) out.set(n, 'dependencies');
      for (const [g, deps] of Object.entries(table(pkg['optional-dependencies']))) for (const n of uvDepNames(deps)) out.set(n, g);
      for (const [g, deps] of Object.entries(table(pkg['dev-dependencies']))) for (const n of uvDepNames(deps)) out.set(n, g);
    }
    return out;
  },
});

export const poetry = pythonAdapter({
  name: 'poetry',
  lockfile: 'poetry.lock',
  flavor: 'poetry',
  install: 'poetry sync --no-interaction',
  direct(pyproject) {
    const out = new Map<string, string>();
    const project = table(pyproject.project);
    for (const r of array(project.dependencies)) out.set(requirementName(String(r)), 'dependencies');
    for (const [g, reqs] of Object.entries(table(project['optional-dependencies'])))
      for (const r of array(reqs)) out.set(requirementName(String(r)), g);
    const tool = table(table(pyproject.tool).poetry);
    for (const n of Object.keys(table(tool.dependencies))) if (n !== 'python') out.set(normalize(n), 'dependencies');
    for (const n of Object.keys(table(tool['dev-dependencies']))) out.set(normalize(n), 'dev');
    for (const [g, grp] of Object.entries(table(tool.group)))
      for (const n of Object.keys(table(table(grp).dependencies))) out.set(normalize(n), g);
    return out;
  },
});
