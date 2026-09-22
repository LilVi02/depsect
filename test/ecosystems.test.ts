// Parsers and edits for uv, Poetry, Cargo and Go, tested against real files
// produced by uv 0.12, Poetry 2.5, Cargo 1.98 and Go 1.27.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cargo, editManifest, pairVersions, parseCargoLock } from '../src/adapters/cargo.ts';
import { go, mergeGoSum, parseGoMod } from '../src/adapters/go.ts';
import { spliceNpmLock } from '../src/adapters/node.ts';
import { composeFlatLock, parseFlatLock, poetry, uv } from '../src/adapters/python.ts';
import type { Update } from '../src/adapters/types.ts';
import { selectUpdates } from '../src/runner.ts';
import { findEntry, findTable, parseToml } from '../src/toml.ts';

const read = (f: string) => readFileSync(new URL(`./lockfiles/${f}`, import.meta.url), 'utf8');

// --- TOML -------------------------------------------------------------------

test('toml: parses real manifests and lockfiles', () => {
  for (const f of ['uv.lock', 'poetry.lock', 'Cargo.lock', 'Cargo.toml', 'uv-pyproject.toml', 'poetry-pyproject.toml']) {
    assert.doesNotThrow(() => parseToml(read(f)), f);
  }
  const cargoToml = parseToml(read('Cargo.toml')) as { dependencies: { serde: { features: string[] } } };
  assert.deepEqual(cargoToml.dependencies.serde.features, ['derive']);
});

test('toml: values, tables and arrays of tables', () => {
  const t = parseToml(`
title = "a \\"quoted\\" \\u00e9"
lit = 'C:\\path'
multi = """
line1
line2"""
n = 1_000
f = 3.5
yes = true
date = 1979-05-27T07:32:00Z
arr = [ 1, 2, # comment
  3, ]
inline = { a.b = 1, "c d" = "e" }
[server."alpha.beta"]
ip = "10.0.0.1"
[[fruit]]
name = "apple"
[fruit.color]
hex = "red"
[[fruit]]
name = "banana"
`);
  assert.equal(t.title, 'a "quoted" é');
  assert.equal(t.lit, 'C:\\path');
  assert.equal(t.multi, 'line1\nline2');
  assert.equal(t.n, 1000);
  assert.equal(t.f, 3.5);
  assert.equal(t.yes, true);
  assert.equal(t.date, '1979-05-27T07:32:00Z');
  assert.deepEqual(t.arr, [1, 2, 3]);
  assert.deepEqual(t.inline, { a: { b: 1 }, 'c d': 'e' });
  assert.deepEqual(t.server, { 'alpha.beta': { ip: '10.0.0.1' } });
  assert.deepEqual(t.fruit, [{ name: 'apple', color: { hex: 'red' } }, { name: 'banana' }]);
});

test('toml: locates entries and tables in the original text', () => {
  const text = read('Cargo.toml');
  const serde = findEntry(text, ['dependencies'], 'serde')!;
  assert.equal(text.slice(serde.start, serde.end), 'serde = { version = "1.0", features = ["derive"] }\n');
  const dev = findTable(text, ['dev-dependencies'])!;
  assert.equal(text.slice(dev.start, dev.end), '[dev-dependencies]\nryu = "1"\n');
  const multi = 'x = [\n  "a",\n  "b",\n]\ny = 1\n';
  const e = findEntry(`[t]\n${multi}`, ['t'], 'x')!;
  assert.equal(`[t]\n${multi}`.slice(e.start, e.end), 'x = [\n  "a",\n  "b",\n]\n');
});

// --- Python -----------------------------------------------------------------

for (const [label, file, flavor] of [['uv', 'uv.lock', 'uv'], ['poetry', 'poetry.lock', 'poetry']] as const) {
  test(`${label}: recomposing an unchanged lockfile gives back the same bytes`, () => {
    const lock = parseFlatLock(read(file), flavor);
    assert.equal(composeFlatLock(lock, lock, new Set(), '\n\n'), read(file));
  });
}

test('uv: reads packages, dependencies and the project entry', () => {
  const lock = parseFlatLock(read('uv.lock'), 'uv');
  const root = lock.blocks.find((b) => b.root)!;
  assert.equal(root.name, 'lf');
  assert.deepEqual(root.deps.sort(), ['orjson', 'pytest', 'pyyaml', 'requests']);
  const requests = lock.blocks.find((b) => b.name === 'requests')!;
  assert.deepEqual(requests.deps.sort(), ['certifi', 'charset-normalizer', 'idna', 'urllib3']);
});

/** Rewrite one package's version inside a lockfile, as if it had been updated. */
const bump = (text: string, name: string, from: string, to: string) =>
  text.replace(new RegExp(`(name = "${name}"\\nversion = )"${from.replace(/\./g, '\\.')}"`), `$1"${to}"`);

test('uv: diff classifies direct and transitive updates', () => {
  const base = { 'pyproject.toml': read('uv-pyproject.toml'), 'uv.lock': read('uv.lock') };
  const requests = /name = "requests"\nversion = "([^"]+)"/.exec(read('uv.lock'))![1]!;
  const idna = /name = "idna"\nversion = "([^"]+)"/.exec(read('uv.lock'))![1]!;
  const head = { ...base, 'uv.lock': bump(bump(read('uv.lock'), 'requests', requests, '9.9.9'), 'idna', idna, '9.9.8') };
  const { updates } = uv.diff(base, head);
  assert.deepEqual(
    updates.map((u) => [u.name, u.kind, u.to]),
    [['idna', 'transitive', '9.9.8'], ['requests', 'direct', '9.9.9']],
  );
});

test('uv/poetry: composing takes updated blocks from head and pulls in new dependencies', () => {
  const lock = (pkgs: [string, string, string[]][]) =>
    'version = 1\n\n' + pkgs.map(([n, v, deps]) => `[[package]]\nname = "${n}"\nversion = "${v}"\nsource = { registry = "x" }\ndependencies = [${deps.map((d) => `{ name = "${d}" }`).join(', ')}]`).join('\n\n') + '\n';
  const root = ['app', '0', ['a', 'b']] as [string, string, string[]];
  const base = parseFlatLock(lock([root, ['a', '1.0', []], ['b', '1.0', []]]).replace('source = { registry = "x" }', 'source = { virtual = "." }'), 'uv');
  const head = parseFlatLock(lock([root, ['a', '2.0', ['c']], ['b', '2.0', []], ['c', '1.0', []]]).replace('source = { registry = "x" }', 'source = { virtual = "." }'), 'uv');
  const composed = parseFlatLock(composeFlatLock(base, head, new Set(['a']), '\n\n'), 'uv');
  assert.deepEqual(composed.blocks.map((b) => `${b.name}@${b.version}`), ['a@2.0', 'app@0', 'b@1.0', 'c@1.0']);
});

test('poetry: direct dependencies come from pyproject.toml (PEP 621 and tool.poetry)', () => {
  const base = { 'pyproject.toml': read('poetry-pyproject.toml'), 'poetry.lock': read('poetry.lock') };
  const lockText = read('poetry.lock');
  const pytest = /name = "pytest"\nversion = "([^"]+)"/.exec(lockText)![1]!;
  const certifi = /name = "certifi"\nversion = "([^"]+)"/.exec(lockText)![1]!;
  const head = { ...base, 'poetry.lock': bump(bump(lockText, 'pytest', pytest, '9.0.0'), 'certifi', certifi, '2099.1.1') };
  const { updates } = poetry.diff(base, head);
  assert.deepEqual(
    updates.map((u) => [u.name, u.kind, u.section]),
    [['certifi', 'transitive', 'lockfile'], ['pytest', 'direct', 'dev']],
  );
});

// --- Cargo ------------------------------------------------------------------

test('cargo: reads the lockfile and finds direct dependencies', () => {
  const crates = parseCargoLock(read('Cargo.lock'));
  const root = crates.find((c) => !c.source)!;
  assert.deepEqual(root.deps, ['itoa', 'ryu', 'serde']);
});

test('cargo: diff pairs versions and classifies updates', () => {
  const base = { 'Cargo.toml': read('Cargo.toml'), 'Cargo.lock': read('Cargo.lock') };
  const itoa = /name = "itoa"\nversion = "([^"]+)"/.exec(read('Cargo.lock'))![1]!;
  const quote = /name = "quote"\nversion = "([^"]+)"/.exec(read('Cargo.lock'))![1]!;
  const head = { ...base, 'Cargo.lock': bump(bump(read('Cargo.lock'), 'itoa', itoa, '1.0.99'), 'quote', quote, '1.0.99') };
  const { updates } = cargo.diff(base, head);
  assert.deepEqual(updates.map((u) => [u.name, u.kind, u.from, u.to]), [
    ['itoa', 'direct', itoa, '1.0.99'],
    ['quote', 'transitive', quote, '1.0.99'],
  ]);
});

test('cargo: pairs semver-compatible versions', () => {
  assert.deepEqual(pairVersions(['1.0.1'], ['1.0.2']), [['1.0.1', '1.0.2']]);
  assert.deepEqual(pairVersions(['0.3.1', '1.2.0'], ['1.4.0', '0.3.5']), [['0.3.1', '0.3.5'], ['1.2.0', '1.4.0']]);
  assert.deepEqual(pairVersions(['1.0.0'], ['2.0.0']), [['1.0.0', '2.0.0']]);
  assert.deepEqual(pairVersions(['1.0.0', '2.0.0'], ['3.0.0', '4.0.0']), []);
});

test('cargo: copies a changed declaration from head without touching the rest', () => {
  const base = read('Cargo.toml');
  const head = base.replace('serde = { version = "1.0", features = ["derive"] }', 'serde = { version = "1.0.200", features = ["derive"] }')
    .replace('ryu = "1"', 'ryu = "1"\nsmallvec = "1.13"');
  assert.equal(editManifest(base, head, 'itoa'), base);
  assert.equal(editManifest(base, head, 'serde'), base.replace('"1.0", features', '"1.0.200", features'));
  assert.equal(editManifest(base, head, 'smallvec'), base.replace('ryu = "1"', 'ryu = "1"\nsmallvec = "1.13"'));
  assert.equal(editManifest(base, base.replace('itoa = "1.0"\n', ''), 'itoa'), base.replace('itoa = "1.0"\n', ''));
});

test('cargo: write plans precise updates, version changes first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'depsect-cargo-'));
  const base = { 'Cargo.toml': read('Cargo.toml'), 'Cargo.lock': read('Cargo.lock') };
  const head = { 'Cargo.toml': read('Cargo.toml').replace('ryu = "1"', 'ryu = "1"\nsmallvec = "1.13"'), 'Cargo.lock': read('Cargo.lock') };
  const cmds = await cargo.write(dir, base, head, [
    { id: 'smallvec', name: 'smallvec', section: 'dependencies', from: null, to: '1.13.2', kind: 'direct' },
    { id: 'quote', name: 'quote', section: 'lockfile', from: '1.0.47', to: '1.0.48', kind: 'transitive' },
  ]);
  assert.deepEqual(cmds, [
    "cargo update -p 'quote@1.0.47' --precise '1.0.48' || cargo update -p 'quote@1.0.48' --precise '1.0.48'",
    'cargo update --workspace',
    "cargo update -p 'smallvec' --precise '1.13.2'",
  ]);
  assert.match(await readFile(join(dir, 'Cargo.toml'), 'utf8'), /smallvec = "1.13"/);
  assert.equal(await readFile(join(dir, 'Cargo.lock'), 'utf8'), base['Cargo.lock']);
});

// --- Go ---------------------------------------------------------------------

test('go: parses require directives', () => {
  const reqs = parseGoMod(`module m\n\ngo 1.22\n\nrequire golang.org/x/mod v0.20.0\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n)\n`);
  assert.deepEqual([...reqs.values()], [
    { path: 'golang.org/x/mod', version: 'v0.20.0', indirect: false },
    { path: 'github.com/a/b', version: 'v1.2.3', indirect: false },
    { path: 'github.com/c/d', version: 'v0.1.0', indirect: true },
  ]);
  assert.equal(parseGoMod(read('go.mod')).get('github.com/google/uuid')?.version, 'v1.6.0');
});

test('go: diff and merged go.sum', () => {
  const base = { 'go.mod': read('go.mod'), 'go.sum': read('go.sum') };
  const head = { 'go.mod': read('go.mod').replace('uuid v1.6.0', 'uuid v1.7.0'), 'go.sum': 'github.com/google/uuid v1.7.0 h1:x=\n' };
  assert.deepEqual(go.diff(base, head).updates.map((u) => [u.name, u.from, u.to, u.kind]), [['github.com/google/uuid', 'v1.6.0', 'v1.7.0', 'direct']]);
  const sum = mergeGoSum(base['go.sum'], head['go.sum']);
  assert.ok(sum.includes('uuid v1.6.0 h1:') && sum.includes('uuid v1.7.0 h1:x='));
});

// --- npm transitive, selection ---------------------------------------------

test('npm: splicing replaces every copy of a package and its nested deps', () => {
  const lock = (pkgs: Record<string, string>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [k, { version: v }])) } });
  const base = lock({ 'node_modules/a': '1.0.0', 'node_modules/x': '1.0.0', 'node_modules/a/node_modules/x': '0.9.0', 'node_modules/x/node_modules/y': '1.0.0' });
  const head = lock({ 'node_modules/a': '1.0.0', 'node_modules/x': '2.0.0', 'node_modules/x/node_modules/z': '1.0.0' });
  const out = JSON.parse(spliceNpmLock(base, head, ['x'])).packages;
  assert.deepEqual(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as { version?: string }).version])), {
    '': undefined,
    'node_modules/a': '1.0.0',
    'node_modules/x': '2.0.0',
    'node_modules/x/node_modules/z': '1.0.0',
  });
});

test('transitive mode selection', () => {
  const u = (name: string, kind: Update['kind']): Update => ({ id: name, name, section: '', from: '1', to: '2', kind });
  const mixed = [u('a', 'direct'), u('t', 'transitive')];
  const lockOnly = [u('t', 'transitive'), u('s', 'transitive')];
  assert.deepEqual(selectUpdates(mixed, 'auto').updates.map((x) => x.name), ['a']);
  assert.deepEqual(selectUpdates(lockOnly, 'auto').updates.map((x) => x.name), ['t', 's']);
  assert.deepEqual(selectUpdates(mixed, 'always').updates.map((x) => x.name), ['a', 't']);
  assert.deepEqual(selectUpdates(lockOnly, 'never').updates, []);
});
