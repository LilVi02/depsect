// Offline end-to-end fixtures for every supported package manager. Each one
// builds a git repo with a base commit and a head commit for a scenario:
//   grouped: a grouped update of the direct dependencies (BEFORE → AFTER)
//   refresh: a lockfile refresh where only transitive packages move
// Packages come from local sources: a static npm registry, a static PEP 503
// index, a Cargo directory source, and a file:// GOPROXY.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shOk } from '../../src/exec.ts';
import { AFTER, BEFORE, gitInit, has, serve, V1, V2, zip, type Pkg, type StaticServer } from './common.ts';

export type Scenario = 'grouped' | 'refresh';

export interface Fixture {
  repo: string;
  /** Test command; on success it prints the installed versions as a JSON line. */
  test: string;
  /** Install command to run after applying the safe files in the repo itself. */
  install: string;
  /** Environment the package manager needs (registry, caches, offline switches). */
  env: Record<string, string>;
  /** The name depsect reports for a universe package, e.g. ds-alpha → example.com/ds/alpha. */
  name: (pkg: string) => string;
  cleanup(): Promise<void>;
}

export interface Ecosystem {
  id: string;
  /** Scenarios that apply (default: both). Build tools without a lockfile have no lockfile refresh. */
  scenarios?: Scenario[];
  /** Reason to skip, or false when the tools are available. */
  skip(): Promise<string | false>;
  make(scenario: Scenario): Promise<Fixture>;
}

export const sh = (cmd: string, cwd: string, env: Record<string, string> = {}) => shOk(cmd, { cwd, env });
export const tmp = (prefix: string) => mkdtemp(join(tmpdir(), `depsect-${prefix}-`));
export const underscore = (n: string) => n.replace(/-/g, '_');

// --- JavaScript ---------------------------------------------------------------

const JS_TEST = `
const v = (n) => require(n).version;
const eps = require('ds-epsilon');
const versions = { alpha: v('ds-alpha'), beta: v('ds-beta'), gamma: v('ds-gamma'), delta: v('ds-delta'), zeta: eps.zeta, eta: eps.eta };
const fail = (m) => { console.error(m); process.exit(1); };
if (versions.alpha === '1.9.0') fail('ds-alpha 1.9.0 changed its API');
if (versions.gamma === '1.1.0' && versions.delta === '1.1.0') fail('ds-gamma 1.1.0 needs ds-delta 1.0');
if (versions.zeta === '1.1.0') fail('ds-zeta 1.1.0 is broken');
console.log(JSON.stringify(versions));
`;

export async function publishNpm(registry: string, work: string, url: string, pkgs: Pkg[]) {
  const byName = new Map<string, Pkg[]>();
  for (const p of pkgs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, versions] of byName) {
    const packument: { name: string; 'dist-tags': { latest: string }; versions: Record<string, unknown>; time: Record<string, string> } = {
      name,
      'dist-tags': { latest: versions[versions.length - 1]!.version },
      versions: {},
      // Old publish dates, so age gates (Yarn's quarantine) do not hold packages back.
      time: Object.fromEntries(versions.map((p) => [p.version, '2020-01-01T00:00:00.000Z'])),
    };
    await mkdir(join(registry, name, '-'), { recursive: true });
    for (const p of versions) {
      const dir = join(work, `${p.name}-${p.version}`);
      await mkdir(dir, { recursive: true });
      const deps = Object.fromEntries(p.deps.map((d) => [d, '^1.0.0']));
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: p.version, main: 'index.js', dependencies: deps }));
      const extra = p.deps.map((d) => `${d.slice(3)}: require('${d}').version`).join(', ');
      await writeFile(join(dir, 'index.js'), `module.exports = { version: '${p.version}'${extra ? `, ${extra}` : ''} };\n`);
      const file = (await sh(`npm pack --silent --pack-destination ${JSON.stringify(join(registry, name, '-'))}`, dir)).trim().split('\n').pop()!;
      const tgz = await import('node:fs/promises').then((fs) => fs.readFile(join(registry, name, '-', file)));
      packument.versions[p.version] = {
        name,
        version: p.version,
        dependencies: deps,
        dist: {
          tarball: `${url}/${name}/-/${file}`,
          shasum: createHash('sha1').update(tgz).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
        },
      };
    }
    await writeFile(join(registry, name, 'index.json'), JSON.stringify(packument));
  }
}

function jsEcosystem(id: 'npm' | 'pnpm' | 'yarn' | 'yarn-berry'): Ecosystem {
  const lockfile = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', 'yarn-berry': 'yarn.lock' }[id];
  const install = {
    npm: 'npm install --no-audit --no-fund --prefer-online --loglevel=error',
    pnpm: 'pnpm install --no-frozen-lockfile',
    yarn: 'yarn install --non-interactive --no-progress',
    'yarn-berry': 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install',
  }[id];
  return {
    id,
    async skip() {
      if (id === 'npm') return false;
      if (!(await has(id === 'pnpm' ? 'pnpm' : 'yarn'))) return `${id} is not installed`;
      if (id === 'yarn-berry' && !process.env.DEPSECT_TEST_BERRY_PATH) return 'set DEPSECT_TEST_BERRY_PATH';
      return false;
    },
    async make(scenario) {
      const root = await tmp(`js-${id}`);
      const registry = join(root, 'registry');
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      // Packuments live at /<name>/index.json; the server maps /<name> to that directory.
      const server: StaticServer = await serve(registry);
      try {
      const url = server.url;
      await publishNpm(registry, join(root, 'work'), url, V1);

      const commit = await gitInit(repo);
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n.yarn/\n.pnp.*\n');
      await writeFile(join(repo, 'test.js'), JS_TEST);
      await writeFile(join(repo, '.npmrc'), `registry=${url}/\n`);
      if (id === 'yarn-berry') {
        await writeFile(join(repo, '.yarnrc.yml'), [
          `yarnPath: ${JSON.stringify(process.env.DEPSECT_TEST_BERRY_PATH)}`,
          'nodeLinker: node-modules',
          'enableTelemetry: false',
          'enableGlobalCache: false',
          // Berry caches registry metadata globally; keep each fixture isolated.
          `globalFolder: ${JSON.stringify(join(root, 'yarn-global'))}`,
          `npmRegistryServer: "${url}"`,
          'unsafeHttpWhitelist: ["127.0.0.1"]',
          'npmMinimalAgeGate: 0',
          '',
        ].join('\n'));
      }
      const manifest = (deps: Record<string, string>) =>
        JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, dependencies: deps }, null, 2) + '\n';
      await writeFile(join(repo, 'package.json'), manifest(BEFORE));
      await sh(install, repo);
      await commit('base');

      await publishNpm(registry, join(root, 'work2'), url, V2);
      if (scenario === 'grouped') await writeFile(join(repo, 'package.json'), manifest(AFTER));
      else {
        // A fresh resolution: package managers reuse an existing node_modules tree otherwise.
        await rm(join(repo, lockfile));
        await rm(join(repo, 'node_modules'), { recursive: true, force: true });
      }
      await sh(install, repo);
      await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');

      return {
        repo,
        test: 'node test.js',
        install,
        env: {},
        name: (p) => p,
        cleanup: () => server.close(),
      };
      } catch (err) {
        await server.close();
        throw err;
      }
    },
  };
}

// --- Python ---------------------------------------------------------------------

const b64sha = (data: Buffer | string) => createHash('sha256').update(data).digest('base64url');

function wheel(p: Pkg): Buffer {
  const mod = underscore(p.name);
  const distInfo = `${mod}-${p.version}.dist-info`;
  const imports = p.deps.map((d) => `import ${underscore(d)}\n`).join('');
  const extra = p.deps.map((d) => `${d.slice(3).toUpperCase()} = ${underscore(d)}.VERSION\n`).join('');
  const files: Record<string, string> = {
    [`${mod}/__init__.py`]: `${imports}VERSION = "${p.version}"\n${extra}`,
    [`${distInfo}/METADATA`]: `Metadata-Version: 2.1\nName: ${p.name}\nVersion: ${p.version}\n${p.deps.map((d) => `Requires-Dist: ${d}<2,>=1\n`).join('')}`,
    [`${distInfo}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: depsect-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
  };
  const record = Object.entries(files).map(([f, c]) => `${f},sha256=${b64sha(c)},${Buffer.byteLength(c)}`);
  files[`${distInfo}/RECORD`] = [...record, `${distInfo}/RECORD,,`, ''].join('\n');
  return zip(files);
}

export async function publishPypi(index: string, pkgs: Pkg[]) {
  await mkdir(join(index, 'files'), { recursive: true });
  const byName = new Map<string, Pkg[]>();
  for (const p of pkgs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, versions] of byName) {
    const links: string[] = [];
    for (const p of versions) {
      const file = `${underscore(p.name)}-${p.version}-py3-none-any.whl`;
      const data = wheel(p);
      await writeFile(join(index, 'files', file), data);
      links.push(`<a href="../../files/${file}#sha256=${createHash('sha256').update(data).digest('hex')}">${file}</a><br>`);
    }
    await mkdir(join(index, 'simple', name), { recursive: true });
    await writeFile(join(index, 'simple', name, 'index.html'), `<!DOCTYPE html><html><body>\n${links.join('\n')}\n</body></html>\n`);
  }
  await writeFile(join(index, 'simple', 'index.html'), `<!DOCTYPE html><html><body>${[...byName.keys()].map((n) => `<a href="${n}/">${n}</a>`).join('')}</body></html>`);
}

export const PY_TEST = `
import json, sys
import ds_alpha, ds_beta, ds_gamma, ds_delta, ds_epsilon
v = dict(alpha=ds_alpha.VERSION, beta=ds_beta.VERSION, gamma=ds_gamma.VERSION, delta=ds_delta.VERSION, zeta=ds_epsilon.ZETA, eta=ds_epsilon.ETA)
def fail(m):
    print(m, file=sys.stderr)
    sys.exit(1)
if v["alpha"] == "1.9.0": fail("ds-alpha 1.9.0 changed its API")
if v["gamma"] == "1.1.0" and v["delta"] == "1.1.0": fail("ds-gamma 1.1.0 needs ds-delta 1.0")
if v["zeta"] == "1.1.0": fail("ds-zeta 1.1.0 is broken")
print(json.dumps(v))
`;

function pythonEcosystem(id: 'uv' | 'poetry'): Ecosystem {
  const lockfile = id === 'uv' ? 'uv.lock' : 'poetry.lock';
  const lock = id === 'uv' ? 'uv lock' : 'poetry lock --no-interaction';
  const install = id === 'uv' ? 'uv sync --frozen' : 'poetry sync --no-interaction';
  return {
    id,
    async skip() {
      return (await has(id)) ? false : `${id} is not installed`;
    },
    async make(scenario) {
      const root = await tmp(`py-${id}`);
      const index = join(root, 'index');
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      const server = await serve(index);
      try {
      await publishPypi(index, V1);
      const env = {
        UV_CACHE_DIR: join(root, 'uv-cache'),
        UV_PYTHON_DOWNLOADS: 'never',
        POETRY_CACHE_DIR: join(root, 'poetry-cache'),
        POETRY_VIRTUALENVS_IN_PROJECT: 'true',
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      };

      const commit = await gitInit(repo);
      await writeFile(join(repo, '.gitignore'), '.venv/\n__pycache__/\n');
      await writeFile(join(repo, 'test.py'), PY_TEST);
      const pyproject = (deps: Record<string, string>) => {
        const reqs = Object.entries(deps).map(([n, v]) => `    "${n}==${v}",`).join('\n');
        const source = id === 'uv'
          ? `[tool.uv]\npackage = false\n\n[[tool.uv.index]]\nname = "local"\nurl = "${server.url}/simple/"\ndefault = true\n`
          : `[tool.poetry]\npackage-mode = false\n\n[[tool.poetry.source]]\nname = "local"\nurl = "${server.url}/simple/"\npriority = "primary"\n`;
        return `[project]\nname = "fixture"\nversion = "0.0.0"\nrequires-python = ">=3.10"\ndependencies = [\n${reqs}\n]\n\n${source}`;
      };
      await writeFile(join(repo, 'pyproject.toml'), pyproject(BEFORE));
      await sh(lock, repo, env);
      await commit('base');

      await publishPypi(index, V2);
      if (scenario === 'grouped') await writeFile(join(repo, 'pyproject.toml'), pyproject(AFTER));
      else await rm(join(repo, lockfile));
      await sh(lock, repo, env);
      await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');

      return {
        repo,
        test: '.venv/bin/python test.py',
        install,
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
}

// --- Cargo ----------------------------------------------------------------------

export async function publishCrates(vendor: string, pkgs: Pkg[]) {
  for (const p of pkgs) {
    const dir = join(vendor, `${p.name}-${p.version}`);
    await mkdir(join(dir, 'src'), { recursive: true });
    const deps = p.deps.map((d) => `${d} = "1"\n`).join('');
    await writeFile(join(dir, 'Cargo.toml'), `[package]\nname = "${p.name}"\nversion = "${p.version}"\nedition = "2021"\n\n[dependencies]\n${deps}`);
    const fns = p.deps.map((d) => `pub fn ${d.slice(3)}() -> &'static str { ${underscore(d)}::VERSION }\n`).join('');
    await writeFile(join(dir, 'src', 'lib.rs'), `pub const VERSION: &str = "${p.version}";\n${fns}`);
    const checksum = createHash('sha256').update(`${p.name}-${p.version}`).digest('hex');
    await writeFile(join(dir, '.cargo-checksum.json'), JSON.stringify({ files: {}, package: checksum }));
  }
}

const CARGO_TEST = `
#[cfg(test)]
mod tests {
    #[test]
    fn deps() {
        let (alpha, gamma, delta) = (ds_alpha::VERSION, ds_gamma::VERSION, ds_delta::VERSION);
        let (zeta, eta) = (ds_epsilon::zeta(), ds_epsilon::eta());
        assert!(alpha != "1.9.0", "ds-alpha 1.9.0 changed its API");
        assert!(!(gamma == "1.1.0" && delta == "1.1.0"), "ds-gamma 1.1.0 needs ds-delta 1.0");
        assert!(zeta != "1.1.0", "ds-zeta 1.1.0 is broken");
        println!("{{\\"alpha\\":\\"{}\\",\\"beta\\":\\"{}\\",\\"gamma\\":\\"{}\\",\\"delta\\":\\"{}\\",\\"zeta\\":\\"{}\\",\\"eta\\":\\"{}\\"}}",
            alpha, ds_beta::VERSION, gamma, delta, zeta, eta);
    }
}
`;

const cargoEcosystem: Ecosystem = {
  id: 'cargo',
  async skip() {
    return (await has('cargo')) ? false : 'cargo is not installed';
  },
  async make(scenario) {
    const repo = await tmp('cargo');
    const env = { CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never' };
    await publishCrates(join(repo, 'vendor'), V1);
    const commit = await gitInit(repo);
    await writeFile(join(repo, '.gitignore'), 'target/\n');
    await mkdir(join(repo, '.cargo'));
    await writeFile(join(repo, '.cargo', 'config.toml'), '[source.crates-io]\nreplace-with = "vendored"\n\n[source.vendored]\ndirectory = "vendor"\n');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'lib.rs'), CARGO_TEST);
    const manifest = (deps: Record<string, string>) =>
      `[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\n${Object.entries(deps).map(([n, v]) => `${n} = "=${v}"`).join('\n')}\n`;
    await writeFile(join(repo, 'Cargo.toml'), manifest(BEFORE));
    await sh('cargo generate-lockfile', repo, env);
    await commit('base');

    await publishCrates(join(repo, 'vendor'), V2);
    if (scenario === 'grouped') {
      await writeFile(join(repo, 'Cargo.toml'), manifest(AFTER));
      await sh('cargo update --workspace', repo, env);
    } else {
      await sh('cargo update', repo, env);
    }
    await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
    return {
      repo,
      // --nocapture so the versions line reaches stdout.
      test: 'cargo test --quiet -- --nocapture',
      install: 'cargo fetch',
      env,
      name: (p) => p,
      cleanup: async () => {},
    };
  },
};

// --- Go -------------------------------------------------------------------------

export const goPath = (name: string) => `example.com/ds/${name.slice(3)}`;

export async function publishGo(proxy: string, pkgs: Pkg[]) {
  const byName = new Map<string, Pkg[]>();
  for (const p of pkgs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, versions] of byName) {
    const mod = goPath(name);
    const dir = join(proxy, mod, '@v');
    await mkdir(dir, { recursive: true });
    for (const p of versions) {
      const v = `v${p.version}`;
      const requires = p.deps.length ? `\nrequire (\n${p.deps.map((d) => `\t${goPath(d)} v1.0.0\n`).join('')})\n` : '';
      const gomod = `module ${mod}\n\ngo 1.21\n${requires}`;
      const pkgName = name.slice(3);
      const imports = p.deps.length ? `import (\n${p.deps.map((d) => `\t"${goPath(d)}"\n`).join('')})\n\n` : '';
      const fns = p.deps.map((d) => `func ${d.slice(3)[0]!.toUpperCase()}${d.slice(4)}() string { return ${d.slice(3)}.Version }\n`).join('');
      const code = `package ${pkgName}\n\n${imports}const Version = "${p.version}"\n\n${fns}`;
      await writeFile(join(dir, `${v}.mod`), gomod);
      await writeFile(join(dir, `${v}.info`), JSON.stringify({ Version: v, Time: '2026-01-01T00:00:00Z' }));
      await writeFile(join(dir, `${v}.zip`), zip({ [`${mod}@${v}/go.mod`]: gomod, [`${mod}@${v}/${pkgName}.go`]: code }));
    }
    await writeFile(join(dir, 'list'), versions.map((p) => `v${p.version}`).join('\n') + '\n');
  }
}

export const GO_TEST = `package fixture

import (
	"encoding/json"
	"fmt"
	"testing"

	"example.com/ds/alpha"
	"example.com/ds/beta"
	"example.com/ds/delta"
	"example.com/ds/epsilon"
	"example.com/ds/gamma"
)

func TestDeps(t *testing.T) {
	v := map[string]string{"alpha": alpha.Version, "beta": beta.Version, "gamma": gamma.Version, "delta": delta.Version, "zeta": epsilon.Zeta(), "eta": epsilon.Eta()}
	if v["alpha"] == "1.9.0" {
		t.Fatal("ds-alpha 1.9.0 changed its API")
	}
	if v["gamma"] == "1.1.0" && v["delta"] == "1.1.0" {
		t.Fatal("ds-gamma 1.1.0 needs ds-delta 1.0")
	}
	if v["zeta"] == "1.1.0" {
		t.Fatal("ds-zeta 1.1.0 is broken")
	}
	out, _ := json.Marshal(v)
	fmt.Println(string(out))
}
`;

const goEcosystem: Ecosystem = {
  id: 'go',
  async skip() {
    return (await has('go')) ? false : 'go is not installed';
  },
  async make(scenario) {
    const root = await tmp('go');
    const proxy = join(root, 'proxy');
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const env = {
      GOPROXY: `file://${proxy}`,
      GOSUMDB: 'off',
      GOFLAGS: '-mod=mod',
      GOTOOLCHAIN: 'local',
      GOMODCACHE: join(root, 'modcache'),
    };
    await publishGo(proxy, V1);
    const commit = await gitInit(repo);
    await writeFile(join(repo, 'fixture_test.go'), GO_TEST);
    const reqs = (deps: Record<string, string>) => Object.entries(deps).map(([n, v]) => `${goPath(n)}@v${v}`).join(' ');
    await writeFile(join(repo, 'go.mod'), 'module example.com/fixture\n\ngo 1.21\n');
    await sh(`go get ${reqs(BEFORE)}`, repo, env);
    await sh('go mod tidy', repo, env);
    await commit('base');

    await publishGo(proxy, V2);
    if (scenario === 'grouped') await sh(`go get ${reqs(AFTER)}`, repo, env);
    else await sh(`go get ${goPath('ds-zeta')}@v1.1.0 ${goPath('ds-eta')}@v1.1.0`, repo, env);
    await sh('go mod tidy', repo, env);
    await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
    return {
      repo,
      test: 'go test -count=1 -v ./...',
      install: 'go mod download',
      env,
      name: goPath,
      cleanup: async () => {
        // The module cache is read-only by design.
        await sh(`chmod -R u+w ${JSON.stringify(root)} && rm -rf ${JSON.stringify(root)}`, tmpdir()).catch(() => {});
      },
    };
  },
};

export const ecosystems: Ecosystem[] = [
  jsEcosystem('npm'),
  jsEcosystem('pnpm'),
  jsEcosystem('yarn'),
  jsEcosystem('yarn-berry'),
  pythonEcosystem('uv'),
  pythonEcosystem('poetry'),
  cargoEcosystem,
  goEcosystem,
];
