// End to end, offline: workspaces (several manifests, one lockfile) for every
// package manager that has them, and one PR that changes two projects.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh } from '../src/exec.ts';
import { run, type RunReport } from '../src/runner.ts';
import { makeMulti, skipMulti, workspaces } from './fixtures/monorepos.ts';

const only = process.env.DEPSECT_E2E?.split(',');

const EXPECT = {
  grouped: {
    culprits: [['ds-alpha'], ['ds-delta', 'ds-gamma']],
    safe: ['ds-beta'],
    kind: 'direct',
    installed: { alpha: '1.0.0', beta: '1.1.0', gamma: '1.0.0', delta: '1.0.0', zeta: '1.0.0', eta: '1.0.0' },
  },
  refresh: {
    culprits: [['ds-zeta']],
    safe: ['ds-eta'],
    kind: 'transitive',
    installed: { alpha: '1.0.0', beta: '1.0.0', gamma: '1.0.0', delta: '1.0.0', zeta: '1.0.0', eta: '1.1.0' },
  },
} as const;

const versionsLine = (out: string) => {
  const line = out.split('\n').map((l) => l.trim()).reverse().find((l) => /^\{.*\}$/.test(l));
  return line ? (JSON.parse(line) as Record<string, string>) : null;
};

/** Culprit sets as sorted name lists, so the order in which they were found does not matter. */
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

for (const eco of workspaces) {
  for (const scenario of ['grouped', 'refresh'] as const) {
    const skip = only && !only.includes(eco.id) ? 'not selected in DEPSECT_E2E' : await eco.skip();
    test(`${eco.id}: ${scenario}`, { skip, timeout: 600_000 }, async () => {
      const fx = await eco.make(scenario);
      try {
        await withEnv(fx.env, async () => {
          const report = await run({ cwd: fx.repo, base: 'HEAD~1', head: 'HEAD', dir: '.', test: fx.test, retries: 0, applySafe: true, log: () => {} });
          const want = EXPECT[scenario];
          assert.equal(report.status, 'found', `status ${report.status}; updates: ${JSON.stringify(report.updates)}`);
          assert.deepEqual(report.projects.length, 1, 'a workspace is one project');
          assert.deepEqual(sets(report), want.culprits.map((c) => [...c]));
          assert.deepEqual(report.result!.safe.map((u) => u.name), [...want.safe]);
          assert.ok(report.updates.every((u) => u.kind === want.kind), `kinds: ${report.updates.map((u) => u.kind)}`);

          const res = await sh(`${fx.install} && ${fx.test}`, { cwd: fx.repo });
          assert.equal(res.code, 0, res.output);
          assert.deepEqual(versionsLine(res.output), want.installed);
        });
      } finally {
        await fx.cleanup();
      }
    });
  }
}

const multiSkip = only && !only.includes('multi') ? 'not selected in DEPSECT_E2E' : await skipMulti();
test('two projects in one PR (npm in web/, Go in api/)', { skip: multiSkip, timeout: 600_000 }, async () => {
  const fx = await makeMulti();
  try {
    await withEnv(fx.env, async () => {
      const report = await run({ cwd: fx.repo, base: 'HEAD~1', head: 'HEAD', dir: '.', test: fx.test, retries: 0, applySafe: true, log: () => {} });
      assert.equal(report.status, 'found', `status ${report.status}; updates: ${JSON.stringify(report.updates)}`);
      assert.deepEqual(report.projects, [{ dir: 'api', adapter: 'go' }, { dir: 'web', adapter: 'npm' }]);
      assert.equal(report.adapter, 'go + npm');
      assert.deepEqual(sets(report), [['ds-alpha'], ['example.com/ds/delta', 'example.com/ds/gamma']]);
      assert.deepEqual(report.result!.culprits.flat().map((u) => u.project).sort(), ['api', 'api', 'web']);
      assert.deepEqual(report.result!.safe.map((u) => `${u.project}:${u.name}`), ['web:ds-beta']);
      // Units carry their project in the id, so equal names in two projects stay apart.
      assert.ok(report.updates.every((u) => u.id.startsWith(`${u.project}:`)));
      assert.ok(Object.keys(report.safeFiles!).includes('web/package.json'));
      assert.ok(Object.keys(report.safeFiles!).includes('api/go.mod'));

      for (const [cmd, dir] of fx.installs) assert.equal((await sh(cmd, { cwd: join(fx.repo, dir) })).code, 0);
      const res = await sh(fx.test, { cwd: fx.repo });
      assert.equal(res.code, 0, res.output);
      assert.deepEqual(versionsLine(res.output), { alpha: '1.0.0', beta: '1.1.0' });
    });
  } finally {
    await fx.cleanup();
  }
});
