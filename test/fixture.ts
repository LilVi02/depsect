// Builds a real git repo whose HEAD commit is a "grouped dependency update"
// that breaks the tests. Packages are local tarballs, so no network is needed.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shOk } from '../src/exec.ts';

const PACKAGES = ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta'];

async function pack(root: string, name: string, version: string) {
  const dir = join(root, 'src-pkgs', `${name}-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  await writeFile(join(dir, 'index.js'), `module.exports = { major: ${version.split('.')[0]} };\n`);
  await shOk(`npm pack --silent --pack-destination ../../vendor`, { cwd: dir });
}

const manifest = (versions: Record<string, string>) =>
  JSON.stringify(
    {
      name: 'fixture-app',
      private: true,
      dependencies: Object.fromEntries(PACKAGES.map((p) => [p, `file:./vendor/${p}-${versions[p] ?? '1.0.0'}.tgz`])),
    },
    null,
    2,
  ) + '\n';

// alpha@2 is broken on its own; gamma@2 and delta@2 are only broken together.
const TEST = `
const d = (n) => require(n).major;
if (d('alpha') === 2) { console.error('alpha@2 changed its API'); process.exit(1); }
if (d('gamma') === 2 && d('delta') === 2) { console.error('gamma@2 is incompatible with delta@2'); process.exit(1); }
console.log('all good');
`;

export async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'depsect-fixture-'));
  await mkdir(join(root, 'vendor'));
  for (const p of PACKAGES) {
    await pack(root, p, '1.0.0');
    await pack(root, p, '2.0.0');
  }
  const git = (cmd: string) => shOk(`git ${cmd}`, { cwd: root });
  const npmInstall = () => shOk('npm install --no-audit --no-fund --loglevel=error', { cwd: root });

  await git('init -q -b main');
  await git('config user.email test@example.com');
  await git('config user.name test');
  await writeFile(join(root, '.gitignore'), 'node_modules/\nsrc-pkgs/\n');
  await writeFile(join(root, 'test.js'), TEST);
  await writeFile(join(root, 'package.json'), manifest({}));
  await npmInstall();
  await git('add -A');
  await git('commit -q -m base');

  await writeFile(join(root, 'package.json'), manifest(Object.fromEntries(PACKAGES.map((p) => [p, '2.0.0']))));
  await npmInstall();
  await git('add -A');
  await git('commit -q -m "chore(deps): bump the everything group with 6 updates"');
  return root;
}
