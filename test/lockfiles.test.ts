// Real lockfiles generated from the npm registry by npm 10, pnpm 10, Yarn 1 and
// Yarn 4 for the same manifest:
//   dependencies:    debug ^4.3.0, @sindresorhus/slugify ^2.0.0
//   devDependencies: ms 2.1.2   (debug itself pulls in ms 2.1.3)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isBerry, npmLock, pnpmLock, yarnLock, type LockReader } from '../src/adapters/lockfiles.ts';

const read = (f: string) => readFileSync(new URL(`./lockfiles/${f}`, import.meta.url), 'utf8');

const cases: [string, LockReader, string][] = [
  ['npm', npmLock, read('package-lock.json')],
  ['pnpm', pnpmLock, read('pnpm-lock.yaml')],
  ['yarn v1', yarnLock, read('yarn-v1.lock')],
  ['yarn berry', yarnLock, read('yarn-berry.lock')],
];

for (const [label, reader, text] of cases) {
  test(`${label}: resolves direct dependencies`, () => {
    assert.equal(reader.direct(text, 'debug', '^4.3.0'), '4.4.3');
    assert.equal(reader.direct(text, '@sindresorhus/slugify', '^2.0.0'), '2.2.1');
    assert.equal(reader.direct(text, 'ms', '2.1.2'), '2.1.2');
    assert.equal(reader.direct(text, 'not-there', '^1.0.0'), undefined);
  });

  test(`${label}: lists every package, including duplicate versions`, () => {
    const all = reader.all(text);
    assert.deepEqual([...all.get('ms')!].sort(), ['2.1.2', '2.1.3']);
    assert.deepEqual([...all.get('debug')!], ['4.4.3']);
    assert.ok(all.has('@sindresorhus/transliterate'), 'transitive scoped package');
    assert.ok(!all.has('lf'), 'the project itself is not a package');
  });
}

test('detects Yarn Berry lockfiles', () => {
  assert.equal(isBerry(read('yarn-berry.lock')), true);
  assert.equal(isBerry(read('yarn-v1.lock')), false);
});
