// Monorepo fixtures: workspaces with one lockfile and several member
// manifests, and a repo with two independent projects changed by one PR.
// Same package universe and scenarios as ecosystems.ts; member "a" depends
// on ds-alpha and ds-beta, member "b" on ds-gamma, ds-delta and ds-epsilon.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AFTER, BEFORE, gitInit, has, serve, V1, V2 } from './common.ts';
import {
  goPath,
  publishCrates,
  publishGo,
  publishNpm,
  publishPypi,
  PY_TEST,
  sh,
  tmp,
  type Ecosystem,
} from './ecosystems.ts';

const A = ['ds-alpha', 'ds-beta'];
const B = ['ds-gamma', 'ds-delta', 'ds-epsilon'];
const pick = (deps: Record<string, string>, names: string[]) => Object.fromEntries(names.map((n) => [n, deps[n]!]));

const put = async (root: string, path: string, text: string) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
};

// --- JavaScript workspaces -------------------------------------------------------

const JS_WS_TEST = `
const versions = { ...require('./packages/a'), ...require('./packages/b') };
const fail = (m) => { console.error(m); process.exit(1); };
if (versions.alpha === '1.9.0') fail('ds-alpha 1.9.0 changed its API');
if (versions.gamma === '1.1.0' && versions.delta === '1.1.0') fail('ds-gamma 1.1.0 needs ds-delta 1.0');
if (versions.zeta === '1.1.0') fail('ds-zeta 1.1.0 is broken');
console.log(JSON.stringify(versions));
`;

// Each member re-exports the versions it sees, so strict layouts (pnpm) work too.
const MEMBER_A = `module.exports = { alpha: require('ds-alpha').version, beta: require('ds-beta').version };\n`;
const MEMBER_B = `const e = require('ds-epsilon');\nmodule.exports = { gamma: require('ds-gamma').version, delta: require('ds-delta').version, zeta: e.zeta, eta: e.eta };\n`;

function jsWorkspace(id: 'npm' | 'pnpm' | 'yarn' | 'yarn-berry'): Ecosystem {
  const lockfile = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', 'yarn-berry': 'yarn.lock' }[id];
  const install = {
    npm: 'npm install --no-audit --no-fund --prefer-online --loglevel=error',
    pnpm: 'pnpm install --no-frozen-lockfile',
    yarn: 'yarn install --non-interactive --no-progress',
    'yarn-berry': 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install',
  }[id];
  return {
    id: `${id}-workspace`,
    async skip() {
      if (id === 'npm') return false;
      if (!(await has(id === 'pnpm' ? 'pnpm' : 'yarn'))) return `${id} is not installed`;
      if (id === 'yarn-berry' && !process.env.DEPSECT_TEST_BERRY_PATH) return 'set DEPSECT_TEST_BERRY_PATH';
      return false;
    },
    async make(scenario) {
      const root = await tmp(`ws-${id}`);
      const registry = join(root, 'registry');
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      const server = await serve(registry);
      try {
        await publishNpm(registry, join(root, 'work'), server.url, V1);
        const commit = await gitInit(repo);
        await put(repo, '.gitignore', 'node_modules/\n.yarn/\n.pnp.*\n');
        await put(repo, '.npmrc', `registry=${server.url}/\n`);
        if (id === 'yarn-berry') {
          await put(repo, '.yarnrc.yml', [
            `yarnPath: ${JSON.stringify(process.env.DEPSECT_TEST_BERRY_PATH)}`,
            'nodeLinker: node-modules',
            'enableTelemetry: false',
            'enableGlobalCache: false',
            `globalFolder: ${JSON.stringify(join(root, 'yarn-global'))}`,
            `npmRegistryServer: "${server.url}"`,
            'unsafeHttpWhitelist: ["127.0.0.1"]',
            'npmMinimalAgeGate: 0',
            '',
          ].join('\n'));
        }
        const rootManifest = { name: 'fixture', version: '0.0.0', private: true, ...(id === 'pnpm' ? {} : { workspaces: ['packages/*'] }) };
        await put(repo, 'package.json', JSON.stringify(rootManifest, null, 2) + '\n');
        if (id === 'pnpm') await put(repo, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
        await put(repo, 'test.js', JS_WS_TEST);
        const member = (name: string, deps: Record<string, string>) =>
          JSON.stringify({ name, version: '0.0.0', private: true, main: 'index.js', dependencies: deps }, null, 2) + '\n';
        const members = async (deps: Record<string, string>) => {
          await put(repo, 'packages/a/package.json', member('a', pick(deps, A)));
          await put(repo, 'packages/b/package.json', member('b', pick(deps, B)));
        };
        await put(repo, 'packages/a/index.js', MEMBER_A);
        await put(repo, 'packages/b/index.js', MEMBER_B);
        await members(BEFORE);
        await sh(install, repo);
        await commit('base');

        await publishNpm(registry, join(root, 'work2'), server.url, V2);
        if (scenario === 'grouped') await members(AFTER);
        else {
          await rm(join(repo, lockfile));
          await sh(`find . -name node_modules -type d -prune -exec rm -rf {} +`, repo);
        }
        await sh(install, repo);
        await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
        return { repo, test: 'node test.js', install, env: {}, name: (p) => p, cleanup: () => server.close() };
      } catch (err) {
        await server.close();
        throw err;
      }
    },
  };
}

// --- uv workspace ------------------------------------------------------------------

const uvWorkspace: Ecosystem = {
  id: 'uv-workspace',
  async skip() {
    return (await has('uv')) ? false : 'uv is not installed';
  },
  async make(scenario) {
    const root = await tmp('ws-uv');
    const index = join(root, 'index');
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const server = await serve(index);
    try {
      await publishPypi(index, V1);
      const env = { UV_CACHE_DIR: join(root, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never' };
      const commit = await gitInit(repo);
      await put(repo, '.gitignore', '.venv/\n__pycache__/\n');
      await put(repo, 'test.py', PY_TEST);
      await put(repo, 'pyproject.toml', [
        '[project]', 'name = "fixture"', 'version = "0.0.0"', 'requires-python = ">=3.10"', 'dependencies = []', '',
        '[tool.uv]', 'package = false', '',
        '[tool.uv.workspace]', 'members = ["packages/*"]', '',
        '[[tool.uv.index]]', 'name = "local"', `url = "${server.url}/simple/"`, 'default = true', '',
      ].join('\n'));
      const member = (name: string, deps: Record<string, string>) =>
        `[project]\nname = "${name}"\nversion = "0.0.0"\nrequires-python = ">=3.10"\ndependencies = [\n${Object.entries(deps).map(([n, v]) => `    "${n}==${v}",`).join('\n')}\n]\n\n[tool.uv]\npackage = false\n`;
      const members = async (deps: Record<string, string>) => {
        await put(repo, 'packages/a/pyproject.toml', member('a', pick(deps, A)));
        await put(repo, 'packages/b/pyproject.toml', member('b', pick(deps, B)));
      };
      await members(BEFORE);
      await sh('uv lock', repo, env);
      await commit('base');

      await publishPypi(index, V2);
      if (scenario === 'grouped') await members(AFTER);
      else await rm(join(repo, 'uv.lock'));
      await sh('uv lock', repo, env);
      await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
      return {
        repo,
        test: '.venv/bin/python test.py',
        install: 'uv sync --frozen --all-packages',
        env,
        name: (p) => p,
        cleanup: () => server.close(),
      };
    } catch (err) {
      await server.close();
      throw err;
    }
  },
};

// --- Cargo workspace -----------------------------------------------------------------

const CARGO_WS_TEST = `
#[cfg(test)]
mod tests {
    #[test]
    fn deps() {
        let (alpha, beta) = (a::alpha(), a::beta());
        let (gamma, delta) = (ds_gamma::VERSION, ds_delta::VERSION);
        let (zeta, eta) = (ds_epsilon::zeta(), ds_epsilon::eta());
        assert!(alpha != "1.9.0", "ds-alpha 1.9.0 changed its API");
        assert!(!(gamma == "1.1.0" && delta == "1.1.0"), "ds-gamma 1.1.0 needs ds-delta 1.0");
        assert!(zeta != "1.1.0", "ds-zeta 1.1.0 is broken");
        println!("{{\\"alpha\\":\\"{}\\",\\"beta\\":\\"{}\\",\\"gamma\\":\\"{}\\",\\"delta\\":\\"{}\\",\\"zeta\\":\\"{}\\",\\"eta\\":\\"{}\\"}}",
            alpha, beta, gamma, delta, zeta, eta);
    }
}
`;

const cargoWorkspace: Ecosystem = {
  id: 'cargo-workspace',
  async skip() {
    return (await has('cargo')) ? false : 'cargo is not installed';
  },
  async make(scenario) {
    const repo = await tmp('ws-cargo');
    const env = { CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never' };
    await publishCrates(join(repo, 'vendor'), V1);
    const commit = await gitInit(repo);
    await put(repo, '.gitignore', 'target/\n');
    await put(repo, '.cargo/config.toml', '[source.crates-io]\nreplace-with = "vendored"\n\n[source.vendored]\ndirectory = "vendor"\n');
    await put(repo, 'Cargo.toml', '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n');
    const pins = (deps: Record<string, string>) => Object.entries(deps).map(([n, v]) => `${n} = "=${v}"`).join('\n');
    const members = async (deps: Record<string, string>) => {
      await put(repo, 'crates/a/Cargo.toml', `[package]\nname = "a"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\n${pins(pick(deps, A))}\n`);
      await put(repo, 'crates/app/Cargo.toml', `[package]\nname = "app"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\na = { path = "../a" }\n${pins(pick(deps, B))}\n`);
    };
    await put(repo, 'crates/a/src/lib.rs', `pub fn alpha() -> &'static str { ds_alpha::VERSION }\npub fn beta() -> &'static str { ds_beta::VERSION }\n`);
    await put(repo, 'crates/app/src/lib.rs', CARGO_WS_TEST);
    await members(BEFORE);
    await sh('cargo generate-lockfile', repo, env);
    await commit('base');

    await publishCrates(join(repo, 'vendor'), V2);
    if (scenario === 'grouped') {
      await members(AFTER);
      await sh('cargo update --workspace', repo, env);
    } else {
      await sh('cargo update', repo, env);
    }
    await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
    return { repo, test: 'cargo test --quiet -- --nocapture', install: 'cargo fetch', env, name: (p) => p, cleanup: async () => {} };
  },
};

export const workspaces: Ecosystem[] = [
  jsWorkspace('npm'),
  jsWorkspace('pnpm'),
  jsWorkspace('yarn'),
  jsWorkspace('yarn-berry'),
  uvWorkspace,
  cargoWorkspace,
];

// --- Two projects in one PR: an npm app in web/ and a Go module in api/ ---------------

export interface MultiFixture {
  repo: string;
  test: string;
  env: Record<string, string>;
  /** Commands (with cwd) that install the safe files in each project. */
  installs: [string, string][];
  cleanup(): Promise<void>;
}

const WEB_TEST = `
const v = (n) => require(n).version;
const versions = { alpha: v('ds-alpha'), beta: v('ds-beta') };
if (versions.alpha === '1.9.0') { console.error('ds-alpha 1.9.0 changed its API'); process.exit(1); }
console.log(JSON.stringify(versions));
`;

const API_TEST = `package api

import (
	"testing"

	"example.com/ds/delta"
	"example.com/ds/epsilon"
	"example.com/ds/gamma"
)

func TestDeps(t *testing.T) {
	if gamma.Version == "1.1.0" && delta.Version == "1.1.0" {
		t.Fatal("ds-gamma 1.1.0 needs ds-delta 1.0")
	}
	if epsilon.Zeta() == "1.1.0" {
		t.Fatal("ds-zeta 1.1.0 is broken")
	}
}
`;

export async function skipMulti(): Promise<string | false> {
  return (await has('go')) ? false : 'go is not installed';
}

/** web/ depends on ds-alpha and ds-beta (npm); api/ on ds-gamma, ds-delta and ds-epsilon (Go). */
export async function makeMulti(): Promise<MultiFixture> {
  const root = await tmp('multi');
  const registry = join(root, 'registry');
  const proxy = join(root, 'proxy');
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const server = await serve(registry);
  const npmInstall = 'npm install --no-audit --no-fund --prefer-online --loglevel=error';
  const env = { GOPROXY: `file://${proxy}`, GOSUMDB: 'off', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', GOMODCACHE: join(root, 'modcache') };
  try {
    await publishNpm(registry, join(root, 'work'), server.url, V1);
    await publishGo(proxy, V1);
    const commit = await gitInit(repo);
    await put(repo, '.gitignore', 'node_modules/\n');
    await put(repo, 'web/.npmrc', `registry=${server.url}/\n`);
    await put(repo, 'web/test.js', WEB_TEST);
    const web = (deps: Record<string, string>) =>
      put(repo, 'web/package.json', JSON.stringify({ name: 'web', private: true, dependencies: pick(deps, A) }, null, 2) + '\n');
    await web(BEFORE);
    await sh(npmInstall, join(repo, 'web'));
    await put(repo, 'api/api_test.go', API_TEST);
    await put(repo, 'api/go.mod', 'module example.com/api\n\ngo 1.21\n');
    const reqs = (deps: Record<string, string>) => B.map((n) => `${goPath(n)}@v${deps[n]}`).join(' ');
    await sh(`go get ${reqs(BEFORE)}`, join(repo, 'api'), env);
    await sh('go mod tidy', join(repo, 'api'), env);
    await commit('base');

    await publishNpm(registry, join(root, 'work2'), server.url, V2);
    await publishGo(proxy, V2);
    await web(AFTER);
    await sh(npmInstall, join(repo, 'web'));
    await sh(`go get ${reqs(AFTER)}`, join(repo, 'api'), env);
    await sh('go mod tidy', join(repo, 'api'), env);
    await commit('chore(deps): bump web and api');
    return {
      repo,
      test: 'node web/test.js && cd api && go test -count=1 ./...',
      env,
      installs: [[npmInstall, 'web'], ['go mod download', 'api']],
      cleanup: async () => {
        await server.close();
        await sh(`chmod -R u+w ${JSON.stringify(root)} && rm -rf ${JSON.stringify(root)}`, '/').catch(() => {});
      },
    };
  } catch (err) {
    await server.close();
    throw err;
  }
}
