// End to end, offline, with the real package managers: for every ecosystem,
// a grouped update (direct dependencies) and a lockfile refresh (transitive
// only). Each test also installs the safe files depsect produced and checks
// the versions that end up installed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sh } from '../src/exec.ts';
import { run } from '../src/runner.ts';
import { ecosystems, type Scenario } from './fixtures/ecosystems.ts';
import { more } from './fixtures/more.ts';

const only = process.env.DEPSECT_E2E?.split(',');

const EXPECT: Record<Scenario, { culprits: string[][]; safe: string[]; kind: string; installed: Record<string, string> }> = {
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
};

const versionsLine = (out: string) => {
  const line = out.split('\n').map((l) => l.trim()).reverse().find((l) => /^\{.*\}$/.test(l));
  return line ? (JSON.parse(line) as Record<string, string>) : null;
};

for (const eco of [...ecosystems, ...more]) {
  for (const scenario of eco.scenarios ?? (['grouped', 'refresh'] as const)) {
    const skip = only && !only.includes(eco.id) ? 'not selected in DEPSECT_E2E' : await eco.skip();
    test(`${eco.id}: ${scenario}`, { skip, timeout: 600_000 }, async () => {
      const fx = await eco.make(scenario);
      const saved = { ...process.env };
      Object.assign(process.env, fx.env);
      try {
        const report = await run({
          cwd: fx.repo, base: 'HEAD~1', head: 'HEAD', dir: '.', test: fx.test, retries: 0, applySafe: true, log: () => {},
        });
        const want = EXPECT[scenario];
        assert.equal(report.adapter, eco.id.replace('-berry', ''));
        assert.equal(report.status, 'found', `status ${report.status}; updates: ${JSON.stringify(report.updates)}`);
        assert.deepEqual(report.result!.culprits.map((c) => c.map((u) => u.name)), want.culprits.map((c) => c.map(fx.name)));
        assert.deepEqual(report.result!.safe.map((u) => u.name), want.safe.map(fx.name));
        assert.ok(report.updates.every((u) => u.kind === want.kind), `kinds: ${report.updates.map((u) => u.kind)}`);

        // The safe files depsect wrote into the repo install the expected versions and pass.
        const res = await sh(`${fx.install} && ${fx.test}`, { cwd: fx.repo });
        assert.equal(res.code, 0, res.output);
        assert.deepEqual(versionsLine(res.output), want.installed);
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        await fx.cleanup();
      }
    });
  }
}
