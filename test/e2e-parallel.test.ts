// End to end with --jobs 3: every ecosystem must find the same culprits as
// in sequential mode, leave working safe files, and clean up every worktree.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh } from '../src/exec.ts';
import { run, type RunReport } from '../src/runner.ts';
import { ecosystems, type Ecosystem, type Scenario } from './fixtures/ecosystems.ts';
import { makeMulti, skipMulti } from './fixtures/monorepos.ts';
import { more } from './fixtures/more.ts';

const JOBS = 3;
const only = process.env.DEPSECT_E2E?.split(',');

const EXPECT: Record<Scenario, { culprits: string[][]; safe: string[] }> = {
  grouped: { culprits: [['ds-alpha'], ['ds-delta', 'ds-gamma']], safe: ['ds-beta'] },
  refresh: { culprits: [['ds-zeta']], safe: ['ds-eta'] },
};

const sets = (r: RunReport) => r.result!.culprits.map((c) => c.map((u) => u.name).sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const cases: [Ecosystem, Scenario][] = [
  ...[...ecosystems, ...more].map((e) => [e, 'grouped'] as [Ecosystem, Scenario]),
  ...ecosystems.filter((e) => ['npm', 'uv', 'cargo'].includes(e.id)).map((e) => [e, 'refresh'] as [Ecosystem, Scenario]),
];

for (const [eco, scenario] of cases) {
  const skip = only && !only.includes(eco.id) ? 'not selected in DEPSECT_E2E' : await eco.skip();
  test(`--jobs ${JOBS}, ${eco.id}: ${scenario}`, { skip, timeout: 900_000 }, async () => {
    const fx = await eco.make(scenario);
    try {
      await withEnv(fx.env, async () => {
        const report = await run({ cwd: fx.repo, base: 'HEAD~1', head: 'HEAD', dir: '.', test: fx.test, retries: 0, jobs: JOBS, applySafe: true, log: () => {} });
        const want = EXPECT[scenario];
        assert.equal(report.status, 'found', `status ${report.status}`);
        assert.equal(report.jobs, JOBS);
        assert.deepEqual(sets(report), want.culprits.map((c) => c.map(fx.name).sort()));
        assert.deepEqual(report.result!.safe.map((u) => u.name), want.safe.map(fx.name));
        assert.ok(report.result!.rounds < report.result!.runs, `${report.result!.rounds} rounds for ${report.result!.runs} runs`);

        const res = await sh(`${fx.install} && ${fx.test}`, { cwd: fx.repo });
        assert.equal(res.code, 0, res.output);
        const worktrees = await sh('git worktree list', { cwd: fx.repo });
        assert.equal(worktrees.output.trim().split('\n').length, 1, worktrees.output);
      });
    } finally {
      await fx.cleanup();
    }
  });
}

const multiSkip = only && !only.includes('multi') ? 'not selected in DEPSECT_E2E' : await skipMulti();
test(`--jobs ${JOBS}, two projects in one PR`, { skip: multiSkip, timeout: 900_000 }, async () => {
  const fx = await makeMulti();
  try {
    await withEnv(fx.env, async () => {
      const report = await run({ cwd: fx.repo, base: 'HEAD~1', head: 'HEAD', dir: '.', test: fx.test, retries: 0, jobs: JOBS, applySafe: true, log: () => {} });
      assert.equal(report.status, 'found');
      assert.deepEqual(sets(report), [['ds-alpha'], ['example.com/ds/delta', 'example.com/ds/gamma']]);
      assert.deepEqual(report.result!.safe.map((u) => `${u.project}:${u.name}`), ['web:ds-beta']);
      for (const [cmd, dir] of fx.installs) assert.equal((await sh(cmd, { cwd: join(fx.repo, dir) })).code, 0);
      assert.equal((await sh(fx.test, { cwd: fx.repo })).code, 0);
    });
  } finally {
    await fx.cleanup();
  }
});
