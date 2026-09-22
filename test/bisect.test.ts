import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseBrokenError, findCulprits, NoFailureError, type Outcome } from '../src/bisect.ts';

const units = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

/** Fails when the subset contains every member of any of the bad groups. */
const oracleFor = (bad: string[][]) => async (subset: string[]): Promise<Outcome> =>
  bad.some((group) => group.every((u) => subset.includes(u))) ? 'fail' : 'pass';

const bisect = (all: string[], bad: string[][]) => findCulprits(all, oracleFor(bad), { key: (u) => u });

test('finds a single culprit in logarithmic runs', async () => {
  const all = units(64);
  const res = await bisect(all, [['u37']]);
  assert.deepEqual(res.culprits, [['u37']]);
  assert.equal(res.safe.length, 63);
  // 2 sanity runs + ~log2(64) bisection steps + 1 confirmation + 1 final check
  assert.ok(res.runs <= 11, `took ${res.runs} runs`);
});

test('finds culprits at the edges', async () => {
  assert.deepEqual((await bisect(units(10), [['u0']])).culprits, [['u0']]);
  assert.deepEqual((await bisect(units(10), [['u9']])).culprits, [['u9']]);
  assert.deepEqual((await bisect(['only'], [['only']])).culprits, [['only']]);
});

test('finds a pair that only fails together', async () => {
  const res = await bisect(units(20), [['u3', 'u15']]);
  assert.deepEqual(res.culprits, [['u3', 'u15']]);
  assert.equal(res.safe.length, 18);
});

test('finds a three-way interaction', async () => {
  const res = await bisect(units(30), [['u2', 'u11', 'u27']]);
  assert.deepEqual(res.culprits, [['u2', 'u11', 'u27']]);
});

test('finds several independent culprits', async () => {
  const res = await bisect(units(40), [['u5'], ['u22'], ['u30', 'u31']]);
  assert.deepEqual(res.culprits, [['u5'], ['u22'], ['u30', 'u31']]);
  assert.equal(res.safe.length, 36);
  assert.equal(await oracleFor([['u5'], ['u22'], ['u30', 'u31']])(res.safe), 'pass');
});

test('reports culprit sets in original order', async () => {
  const res = await bisect(units(8), [['u6', 'u1']]);
  assert.deepEqual(res.culprits, [['u1', 'u6']]);
});

test('everything is a culprit', async () => {
  const res = await bisect(units(3), [['u0'], ['u1'], ['u2']]);
  assert.deepEqual(res.culprits, [['u0'], ['u1'], ['u2']]);
  assert.deepEqual(res.safe, []);
});

test('never runs the same subset twice', async () => {
  const seen = new Set<string>();
  await findCulprits(units(32), async (s) => {
    const k = s.join(',');
    assert.ok(!seen.has(k), `re-ran ${k}`);
    seen.add(k);
    return oracleFor([['u4', 'u20'], ['u9']])(s);
  }, { key: (u) => u });
});

test('rejects a broken base', async () => {
  await assert.rejects(findCulprits(units(4), async () => 'fail', { key: (u) => u }), BaseBrokenError);
});

test('rejects when nothing fails', async () => {
  await assert.rejects(bisect(units(4), []), NoFailureError);
});

test('terminates with a flaky oracle', async () => {
  let n = 0;
  const flaky = async (s: string[]): Promise<Outcome> => (s.length === 0 ? 'pass' : n++ % 3 === 0 ? 'fail' : 'pass');
  // Must not hang or throw on inconsistent answers once past the sanity checks.
  await findCulprits(units(16), async (s) => (s.length === 16 ? 'fail' : flaky(s)), { key: (u) => u });
});
