import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh } from '../src/exec.ts';
import { toMarkdown } from '../src/report.ts';
import { run } from '../src/runner.ts';
import { makeFixture } from './fixture.ts';

test('end to end: finds the broken bump and the broken pair in a real npm repo', { timeout: 180_000 }, async () => {
  const repo = await makeFixture();
  const report = await run({
    cwd: repo,
    base: 'HEAD~1',
    head: 'HEAD',
    dir: '.',
    test: 'node test.js',
    retries: 0,
    applySafe: true,
    log: () => {},
  });

  assert.equal(report.status, 'found');
  assert.deepEqual(report.result!.culprits.map((c) => c.map((u) => u.name)), [['alpha'], ['delta', 'gamma']]);
  assert.deepEqual(report.result!.safe.map((u) => u.name), ['beta', 'epsilon', 'zeta']);
  assert.match(report.culpritLogs[0]!, /alpha@2 changed its API/);
  assert.match(report.culpritLogs[1]!, /gamma@2 is incompatible with delta@2/);

  // --apply-safe rewrote the working tree: the safe bumps are in, the culprits are not.
  const deps = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).dependencies;
  assert.match(deps.beta, /beta-2\.0\.0/);
  assert.match(deps.alpha, /alpha-1\.0\.0/);
  // Both halves of an incompatible pair are held back; each is fine on its own,
  // but picking which one to keep is a human decision.
  assert.match(deps.gamma, /gamma-1\.0\.0/);
  assert.match(deps.delta, /delta-1\.0\.0/);
  assert.equal((await sh('npm install --no-audit --no-fund --loglevel=error && node test.js', { cwd: repo })).code, 0);

  // The worktree was cleaned up.
  const worktrees = await sh('git worktree list', { cwd: repo });
  assert.equal(worktrees.output.trim().split('\n').length, 1);

  const md = toMarkdown(report, 'node test.js');
  assert.match(md, /3 updates out of 6 broke the build/);
  assert.match(md, /\| `alpha` \|/);
});
