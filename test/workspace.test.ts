import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cargo } from '../src/adapters/cargo.ts';
import { npm, pnpm, workspacePatterns } from '../src/adapters/node.ts';
import { shOk } from '../src/exec.ts';
import { discoverProjects } from '../src/runner.ts';
import { globToRegExp, matchMembers } from '../src/workspace.ts';

test('workspace globs', () => {
  assert.ok(globToRegExp('packages/*').test('packages/a'));
  assert.ok(!globToRegExp('packages/*').test('packages/a/b'));
  assert.ok(globToRegExp('packages/**').test('packages/a/b'));
  assert.ok(globToRegExp('apps/**/web').test('apps/web'));
  assert.ok(globToRegExp('apps/**/web').test('apps/x/y/web'));
  assert.ok(globToRegExp('./tools/cli/').test('tools/cli'));
  assert.ok(!globToRegExp('packages/*').test('packagesx/a'));
});

test('workspace members from globs, exclusions and node_modules', () => {
  const paths = [
    'package.json',
    'packages/a/package.json',
    'packages/b/package.json',
    'packages/legacy/package.json',
    'packages/a/node_modules/x/package.json',
    'apps/web/package.json',
    'docs/package.json',
  ];
  assert.deepEqual(matchMembers(['packages/*', 'apps/*', '!packages/legacy'], paths, 'package.json'), [
    'apps/web/package.json',
    'packages/a/package.json',
    'packages/b/package.json',
  ]);
});

test('workspace patterns: npm/Yarn package.json and pnpm-workspace.yaml', () => {
  assert.deepEqual(workspacePatterns({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }) }), ['packages/*']);
  assert.deepEqual(workspacePatterns({ 'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }) }), ['apps/*']);
  const yaml = `packages:\n  # apps\n  - 'apps/*'\n  - "packages/**"\n  - '!**/test/**'\ncatalog:\n  react: ^19\n`;
  assert.deepEqual(workspacePatterns({ 'package.json': '{}', 'pnpm-workspace.yaml': yaml }), ['apps/*', 'packages/**', '!**/test/**']);
  assert.deepEqual(pnpm.members!({ 'package.json': '{}', 'pnpm-workspace.yaml': yaml }, ['apps/x/package.json', 'packages/y/z/package.json']), [
    'apps/x/package.json',
    'packages/y/z/package.json',
  ]);
});

test('npm workspaces: updates declared in member manifests', () => {
  const lock = (versions: Record<string, string>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { workspaces: ['packages/*'] },
        'packages/a': { name: 'a', version: '1.0.0' },
        'node_modules/a': { resolved: 'packages/a', link: true },
        ...Object.fromEntries(Object.entries(versions).map(([k, v]) => [`node_modules/${k}`, { version: v }])),
      },
    });
  const root = JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] });
  const base = { 'package.json': root, 'package-lock.json': lock({ react: '18.2.0', lodash: '4.17.20' }), 'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { react: '^18.2.0', lodash: '^4.17.20' } }) };
  const head = { 'package.json': root, 'package-lock.json': lock({ react: '18.3.1', lodash: '4.17.20' }), 'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { react: '^18.3.0', lodash: '^4.17.20' } }) };
  const { updates } = npm.diff(base, head);
  assert.deepEqual(updates.map((u) => [u.name, u.from, u.to, u.kind]), [['react', '18.2.0', '18.3.1', 'direct']]);
});

test('cargo workspace members come from [workspace] members/exclude', () => {
  const man = '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/old"]\nresolver = "2"\n';
  assert.deepEqual(cargo.members!({ 'Cargo.toml': man }, ['Cargo.toml', 'crates/a/Cargo.toml', 'crates/old/Cargo.toml', 'crates/a/src/lib.rs']), [
    'crates/a/Cargo.toml',
  ]);
});

test('project discovery maps changed files to the directory with the lockfile', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'depsect-discover-'));
  const git = (cmd: string) => shOk(`git ${cmd}`, { cwd: repo });
  const put = async (path: string, text: string) => {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), text);
  };
  await git('init -q -b main');
  await git('config user.email t@e.st');
  await git('config user.name t');
  // An npm workspace, a Go module and a project that does not change.
  await put('web/package.json', JSON.stringify({ name: 'web', private: true, workspaces: ['packages/*'] }));
  await put('web/package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  await put('web/packages/ui/package.json', JSON.stringify({ name: 'ui', dependencies: { react: '^18.2.0' } }));
  await put('api/go.mod', 'module example.com/api\n\ngo 1.21\n\nrequire example.com/x v1.0.0\n');
  await put('tools/package.json', '{"name":"tools"}');
  await put('tools/package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  await put('README.md', 'hi');
  await git('add -A');
  await git('commit -q -m base');
  await put('web/packages/ui/package.json', JSON.stringify({ name: 'ui', dependencies: { react: '^18.3.0' } }));
  await put('api/go.mod', 'module example.com/api\n\ngo 1.21\n\nrequire example.com/x v1.1.0\n');
  await put('README.md', 'changed');
  await git('add -A');
  await git('commit -q -m head');

  const projects = await discoverProjects(repo, 'HEAD~1', 'HEAD', '.');
  assert.deepEqual(projects.map((p) => [p.dir, p.adapter.name]), [['api', 'go'], ['web', 'npm']]);
  const web = projects.find((p) => p.dir === 'web')!;
  assert.ok('packages/ui/package.json' in web.head, 'workspace member manifests are read');

  // Scoped to a subdirectory, only projects below it count.
  const scoped = await discoverProjects(repo, 'HEAD~1', 'HEAD', 'web');
  assert.deepEqual(scoped.map((p) => [p.dir, p.adapter.name]), [['', 'npm']]);
});
