import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { npm } from '../src/adapters/npm.ts';
import type { Snapshot } from '../src/adapters/types.ts';

const snap = (man: object, lock: Record<string, string>): Snapshot => ({
  'package.json': JSON.stringify(man, null, 2),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, ...Object.fromEntries(Object.entries(lock).map(([k, v]) => [`node_modules/${k}`, { version: v }])) },
  }),
});

const base = snap(
  { dependencies: { react: '^18.2.0', lodash: '^4.17.20', left: '1.0.0' }, devDependencies: { vitest: '^1.0.0' } },
  { react: '18.2.0', lodash: '4.17.20', left: '1.0.0', vitest: '1.0.0', 'deep-dep': '1.0.0' },
);
const head = snap(
  { dependencies: { react: '^18.3.0', lodash: '^4.17.20', added: '^2.0.0' }, devDependencies: { vitest: '^2.0.0' } },
  { react: '18.3.1', lodash: '4.17.21', added: '2.0.0', vitest: '2.0.0', 'deep-dep': '1.1.0' },
);

test('diff finds spec changes, lockfile-only bumps, additions and removals', () => {
  const byName = Object.fromEntries(npm.diff(base, head).map((u) => [u.name, u]));
  assert.deepEqual(Object.keys(byName).sort(), ['added', 'left', 'lodash', 'react', 'vitest']);
  assert.deepEqual([byName.react!.from, byName.react!.to], ['18.2.0', '18.3.1']);
  assert.deepEqual([byName.lodash!.from, byName.lodash!.to], ['4.17.20', '4.17.21']);
  assert.deepEqual([byName.added!.from, byName.added!.to], [null, '2.0.0']);
  assert.deepEqual([byName.left!.from, byName.left!.to], ['1.0.0', null]);
  assert.equal(byName.vitest!.section, 'devDependencies');
});

test('notes transitive-only changes', () => {
  assert.match(npm.notes(base, head).join(), /1 transitive package/);
});

test('write applies only the chosen subset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'depsect-npm-'));
  const updates = npm.diff(base, head);
  const pick = (...names: string[]) => updates.filter((u) => names.includes(u.name));

  await npm.write(dir, base, head, pick('react', 'lodash', 'left', 'added'));
  const man = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(man.dependencies, {
    react: '^18.3.0', // spec changed: take head's spec
    lodash: '4.17.21', // lockfile-only bump: pin the exact version
    added: '^2.0.0',
  });
  assert.deepEqual(man.devDependencies, { vitest: '^1.0.0' }); // untouched
  assert.equal(await readFile(join(dir, 'package-lock.json'), 'utf8'), base['package-lock.json']);
});
