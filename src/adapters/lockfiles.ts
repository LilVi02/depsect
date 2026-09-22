// Just enough lockfile parsing to answer two questions:
//   1. which version does the lockfile resolve for this direct dependency?
//   2. which name@version pairs does it contain overall? (for the transitive note)
// No dependencies: pnpm and Yarn Berry lockfiles use a small, regular subset
// of YAML, and Yarn v1 has its own simple format.

export interface LockReader {
  /** Resolved version of a direct dependency declared as `name: spec`. */
  direct(text: string, name: string, spec: string): string | undefined;
  /** Every package in the lockfile: name → set of resolved versions. */
  all(text: string): Map<string, Set<string>>;
}

type Tree = { [key: string]: Tree | string };

const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** Minimal block-YAML reader: nested maps and scalars. List items are skipped. */
export function parseYamlish(text: string): Tree {
  const root: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: root }];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ')) continue;
    const indent = raw.length - raw.trimStart().length;
    // The key ends at the first colon followed by whitespace or end of line,
    // so keys like `foo@file:vendor/foo.tgz:` work.
    const m = /^((?:"(?:[^"\\]|\\.)*")|(?:'[^']*')|.+?):(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    const key = unquote(m[1]!);
    const value = m[2]?.trim();
    if (value === undefined || value === '') {
      const child: Tree = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

const sub = (t: Tree | string | undefined, key: string): Tree | undefined => {
  const v = typeof t === 'object' ? t[key] : undefined;
  return typeof v === 'object' ? v : undefined;
};

/** "@scope/name@1.2.3" → ["@scope/name", "1.2.3"] */
function splitAt(id: string): [string, string] {
  const i = id.indexOf('@', 1);
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

function add(map: Map<string, Set<string>>, name: string, version: string) {
  let set = map.get(name);
  if (!set) map.set(name, (set = new Set()));
  set.add(version);
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

// --- npm: package-lock.json (lockfileVersion 2 and 3) -----------------------

interface NpmLock {
  packages?: Record<string, { version?: string }>;
}

export const npmLock: LockReader = {
  direct(text, name) {
    return (JSON.parse(text) as NpmLock).packages?.[`node_modules/${name}`]?.version;
  },
  all(text) {
    const out = new Map<string, Set<string>>();
    for (const [key, pkg] of Object.entries((JSON.parse(text) as NpmLock).packages ?? {})) {
      const i = key.lastIndexOf('node_modules/');
      if (i < 0 || !pkg.version) continue;
      add(out, key.slice(i + 'node_modules/'.length), pkg.version);
    }
    return out;
  },
};

// --- pnpm: pnpm-lock.yaml (v6 and v9 formats) -------------------------------

// Peer-dependency suffixes like "18.3.1(react@18.3.1)" are not part of the version.
const stripPeers = (v: string) => v.replace(/\(.*$/, '');

export const pnpmLock: LockReader = {
  direct(text, name) {
    const tree = parseYamlish(text);
    const importer = sub(sub(tree, 'importers'), '.') ?? tree;
    for (const s of DEP_SECTIONS) {
      const entry = sub(importer, s)?.[name];
      if (typeof entry === 'string') return stripPeers(entry);
      if (entry && typeof entry.version === 'string') return stripPeers(entry.version);
    }
    return undefined;
  },
  all(text) {
    const out = new Map<string, Set<string>>();
    for (const key of Object.keys(sub(parseYamlish(text), 'packages') ?? {})) {
      const id = stripPeers(key.replace(/^\//, ''));
      // v5 used "/name/1.2.3"; v6+ uses "name@1.2.3".
      const [name, version] = id.includes('@', 1) ? splitAt(id) : [id.slice(0, id.lastIndexOf('/')), id.slice(id.lastIndexOf('/') + 1)];
      add(out, name, version);
    }
    return out;
  },
};

// --- Yarn: yarn.lock (v1 classic and Berry) ---------------------------------

interface YarnEntry {
  descriptors: string[];
  version: string;
}

export const isBerry = (text: string) => /^__metadata:/m.test(text);

function yarnEntries(text: string): YarnEntry[] {
  const entries: YarnEntry[] = [];
  if (isBerry(text)) {
    for (const [key, value] of Object.entries(parseYamlish(text))) {
      if (key === '__metadata' || typeof value !== 'object' || typeof value.version !== 'string') continue;
      if (key.includes('@workspace:')) continue; // the project itself, or a monorepo package
      entries.push({ descriptors: key.split(/,\s*/).map(unquote), version: value.version });
    }
    return entries;
  }
  // v1: unindented `"a@^1", a@^1.2:` headers followed by indented `version "1.2.3"`.
  let current: YarnEntry | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line) && line.trimEnd().endsWith(':')) {
      current = { descriptors: line.trimEnd().slice(0, -1).split(/,\s*/).map(unquote), version: '' };
      entries.push(current);
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (m && current && !current.version) current.version = m[1]!;
  }
  return entries.filter((e) => e.version);
}

export const yarnLock: LockReader = {
  direct(text, name, spec) {
    const wanted = new Set([`${name}@${spec}`, `${name}@npm:${spec}`]);
    return yarnEntries(text).find((e) => e.descriptors.some((d) => wanted.has(d)))?.version;
  },
  all(text) {
    const out = new Map<string, Set<string>>();
    for (const e of yarnEntries(text)) add(out, splitAt(e.descriptors[0]!)[0], e.version);
    return out;
  },
};
