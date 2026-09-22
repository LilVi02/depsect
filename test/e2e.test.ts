import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh } from '../src/exec.ts';
import { toMarkdown } from '../src/report.ts';
import { run } from '../src/runner.ts';
import { berryPath, INSTALL, makeFixture, type Manager } from './fixtures/tarballs.ts';

const has = async (bin: string) => (await sh(`command -v ${bin}`, { cwd: process.cwd() })).code === 0;

const managers: [Manager, string | false][] = [
  ['npm', false],
  ['pnpm', !(await has('pnpm')) && 'pnpm is not installed'],
  ['yarn', !(await has('yarn')) && 'yarn is not installed'],
  ['yarn-berry', (!(await has('yarn')) || !berryPath) && 'set DEPSECT_TEST_BERRY_PATH and install yarn'],
];

for (const [manager, skip] of managers) test(`end to end (${manager}): finds the broken bump and the broken pair`, { timeout: 300_000, skip }, async () => {
  const repo = await makeFixture(manager);
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

  assert.equal(report.adapter, manager.replace('-berry', ''));
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
  assert.equal((await sh(`${INSTALL[manager]} && node test.js`, { cwd: repo })).code, 0, 'safe set must pass after --apply-safe');

  // The worktree was cleaned up.
  const worktrees = await sh('git worktree list', { cwd: repo });
  assert.equal(worktrees.output.trim().split('\n').length, 1);

  const md = toMarkdown(report, 'node test.js');
  assert.match(md, /3 updates out of 6 broke the build/);
  assert.match(md, /\| `alpha` \|/);
});
