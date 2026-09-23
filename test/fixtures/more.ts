// End-to-end fixtures for Composer, Bundler, Maven and Gradle, using the same
// package universe as ecosystems.ts:
//   Composer: an "artifact" repository (a folder of zips), Packagist disabled
//   Bundler:  a static RubyGems compact index (/versions, /info, /gems)
//   Maven, Gradle: a file:// Maven repository with jars built by javac/jar.
//     Build plugins and JUnit come from Maven Central (cached across runs).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AFTER, BEFORE, gitInit, has, serve, V1, V2, zip, type Pkg } from './common.ts';
import { sh, tmp, type Ecosystem } from './ecosystems.ts';

const put = async (root: string, path: string, text: string | Buffer) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
};
const short = (name: string) => name.slice(3); // ds-alpha → alpha
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const q = JSON.stringify;

// --- Composer ---------------------------------------------------------------------

const composerName = (n: string) => `ds/${short(n)}`;

async function publishComposer(dir: string, pkgs: Pkg[]) {
  for (const p of pkgs) {
    const ns = `Ds\\${cap(short(p.name))}`;
    const deps = p.deps.map((d) => `    public static function ${short(d)}(): string { return \\Ds\\${cap(short(d))}\\Version::get(); }\n`).join('');
    const manifest = {
      name: composerName(p.name),
      version: p.version,
      require: Object.fromEntries(p.deps.map((d) => [composerName(d), '^1.0'])),
      autoload: { 'psr-4': { [`${ns}\\`]: 'src/' } },
    };
    await put(dir, `${short(p.name)}-${p.version}.zip`, zip({
      'composer.json': JSON.stringify(manifest, null, 4),
      'src/Version.php': `<?php\nnamespace ${ns};\n\nclass Version\n{\n    public static function get(): string { return '${p.version}'; }\n${deps}}\n`,
    }));
  }
}

const PHP_TEST = `<?php
require __DIR__ . '/vendor/autoload.php';
$v = [
  'alpha' => \\Ds\\Alpha\\Version::get(), 'beta' => \\Ds\\Beta\\Version::get(),
  'gamma' => \\Ds\\Gamma\\Version::get(), 'delta' => \\Ds\\Delta\\Version::get(),
  'zeta' => \\Ds\\Epsilon\\Version::zeta(), 'eta' => \\Ds\\Epsilon\\Version::eta(),
];
function fail($m) { fwrite(STDERR, $m . "\\n"); exit(1); }
if ($v['alpha'] === '1.9.0') fail('ds-alpha 1.9.0 changed its API');
if ($v['gamma'] === '1.1.0' && $v['delta'] === '1.1.0') fail('ds-gamma 1.1.0 needs ds-delta 1.0');
if ($v['zeta'] === '1.1.0') fail('ds-zeta 1.1.0 is broken');
echo json_encode($v), "\\n";
`;

const composerEco: Ecosystem = {
  id: 'composer',
  async skip() {
    return (await has('composer')) ? false : 'composer is not installed';
  },
  async make(scenario) {
    const root = await tmp('composer');
    const artifacts = join(root, 'artifacts');
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const env = { COMPOSER_HOME: join(root, 'composer-home'), COMPOSER_CACHE_DIR: join(root, 'composer-cache'), COMPOSER_NO_INTERACTION: '1' };
    await publishComposer(artifacts, V1);
    const commit = await gitInit(repo);
    await put(repo, '.gitignore', 'vendor/\n');
    await put(repo, 'test.php', PHP_TEST);
    const manifest = (deps: Record<string, string>) =>
      JSON.stringify({
        name: 'fixture/app',
        require: Object.fromEntries(Object.entries(deps).map(([n, v]) => [composerName(n), v])),
        repositories: [{ type: 'artifact', url: artifacts }, { 'packagist.org': false }],
      }, null, 4) + '\n';
    await put(repo, 'composer.json', manifest(BEFORE));
    await sh('composer update --no-progress --quiet', repo, env);
    await commit('base');

    await publishComposer(artifacts, V2);
    if (scenario === 'grouped') {
      await put(repo, 'composer.json', manifest(AFTER));
      await sh(`composer update --no-progress --quiet ${['ds-alpha', 'ds-beta', 'ds-gamma', 'ds-delta'].map(composerName).join(' ')}`, repo, env);
    } else {
      await sh('composer update --no-progress --quiet', repo, env);
    }
    await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
    return {
      repo,
      test: 'php test.php',
      install: 'composer install --no-progress --quiet',
      env,
      name: composerName,
      cleanup: async () => {},
    };
  },
};

// --- Bundler ------------------------------------------------------------------------

const rubyName = (n: string) => n.replace(/-/g, '_'); // file / module base name

async function buildGems(work: string, pkgs: Pkg[]): Promise<Map<string, Buffer>> {
  const gems = new Map<string, Buffer>();
  for (const p of pkgs) {
    const dir = join(work, `${p.name}-${p.version}`);
    const mod = rubyName(p.name).split('_').map(cap).join('');
    const requires = p.deps.map((d) => `require "${rubyName(d)}"\n`).join('');
    const fns = p.deps.map((d) => `  def self.${short(d)} = ${rubyName(d).split('_').map(cap).join('')}::VERSION\n`).join('');
    await put(dir, `lib/${rubyName(p.name)}.rb`, `${requires}module ${mod}\n  VERSION = "${p.version}"\n${fns}end\n`);
    await put(dir, `${p.name}.gemspec`, [
      'Gem::Specification.new do |s|',
      `  s.name = ${q(p.name)}`,
      `  s.version = ${q(p.version)}`,
      '  s.summary = "depsect test gem"',
      '  s.authors = ["depsect"]',
      `  s.files = [${q(`lib/${rubyName(p.name)}.rb`)}]`,
      ...p.deps.map((d) => `  s.add_dependency ${q(d)}, "~> 1.0"`),
      'end',
      '',
    ].join('\n'));
    await sh(`gem build --silent ${p.name}.gemspec`, dir);
    gems.set(`${p.name}-${p.version}`, await readFile(join(dir, `${p.name}-${p.version}.gem`)));
  }
  return gems;
}

/** A static compact index: /versions, /info/<gem>, /gems/<gem>-<version>.gem. */
async function publishGems(index: string, work: string, pkgs: Pkg[]) {
  const gems = await buildGems(work, pkgs);
  const byName = new Map<string, Pkg[]>();
  for (const p of pkgs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  const versions = ['created_at: 2026-01-01T00:00:00Z', '---'];
  for (const [name, vs] of byName) {
    const info = ['---', ...vs.map((p) => {
      const sha = createHash('sha256').update(gems.get(`${p.name}-${p.version}`)!).digest('hex');
      return `${p.version} ${p.deps.map((d) => `${d}:~> 1.0`).join(',')}|checksum:${sha}`;
    })].join('\n') + '\n';
    await put(index, `info/${name}`, info);
    versions.push(`${name} ${vs.map((p) => p.version).join(',')} ${createHash('md5').update(info).digest('hex')}`);
    for (const p of vs) await put(index, `gems/${p.name}-${p.version}.gem`, gems.get(`${p.name}-${p.version}`)!);
  }
  await put(index, 'versions', versions.join('\n') + '\n');
}

const RUBY_TEST = `require "bundler/setup"
require "json"
require "ds_alpha"
require "ds_beta"
require "ds_gamma"
require "ds_delta"
require "ds_epsilon"
v = { alpha: DsAlpha::VERSION, beta: DsBeta::VERSION, gamma: DsGamma::VERSION, delta: DsDelta::VERSION, zeta: DsEpsilon.zeta, eta: DsEpsilon.eta }
abort "ds-alpha 1.9.0 changed its API" if v[:alpha] == "1.9.0"
abort "ds-gamma 1.1.0 needs ds-delta 1.0" if v[:gamma] == "1.1.0" && v[:delta] == "1.1.0"
abort "ds-zeta 1.1.0 is broken" if v[:zeta] == "1.1.0"
puts JSON.generate(v)
`;

const bundlerEco: Ecosystem = {
  id: 'bundler',
  async skip() {
    return (await has('bundle')) && (await has('gem')) ? false : 'bundler is not installed';
  },
  async make(scenario) {
    const root = await tmp('bundler');
    const index = join(root, 'index');
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const server = await serve(index);
    try {
      const env = {
        BUNDLE_PATH: join(root, 'bundle'),
        BUNDLE_USER_HOME: join(root, 'bundle-home'),
        BUNDLE_APP_CONFIG: join(root, 'bundle-config'),
        BUNDLE_DISABLE_VERSION_CHECK: 'true',
      };
      await publishGems(index, join(root, 'work'), V1);
      const commit = await gitInit(repo);
      await put(repo, 'test.rb', RUBY_TEST);
      const gemfile = (deps: Record<string, string>) =>
        `source ${q(server.url)}\n\n${Object.entries(deps).map(([n, v]) => `gem ${q(n)}, ${q(v)}`).join('\n')}\n`;
      await put(repo, 'Gemfile', gemfile(BEFORE));
      await sh('bundle lock', repo, env);
      await commit('base');

      await publishGems(index, join(root, 'work2'), V2);
      if (scenario === 'grouped') {
        await put(repo, 'Gemfile', gemfile(AFTER));
        await sh('bundle lock --conservative --update ds-alpha ds-beta ds-gamma ds-delta', repo, env);
      } else {
        await sh('bundle lock --update', repo, env);
      }
      await commit(scenario === 'grouped' ? 'chore(deps): bump the group' : 'chore(deps): lock file maintenance');
      return {
        repo,
        test: 'bundle exec ruby test.rb',
        install: 'bundle install --quiet',
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

// --- Maven repository (shared by Maven and Gradle) -----------------------------------

const JVM_CACHE = join(tmpdir(), 'depsect-jvm-cache');

/** Build ds:<name>:<version> jars and poms into a Maven repository layout. */
async function publishJars(repo: string, work: string, pkgs: Pkg[]) {
  // Dependencies first, so dependents compile against them.
  const ordered = [...pkgs].sort((a, b) => a.deps.length - b.deps.length);
  for (const p of ordered) {
    const pkg = short(p.name);
    const dir = join(work, `${p.name}-${p.version}`);
    const deps = p.deps.map((d) => `    public static String ${short(d)}() { return ds.${short(d)}.${cap(short(d))}.version(); }\n`).join('');
    await put(dir, `src/ds/${pkg}/${cap(pkg)}.java`, `package ds.${pkg};\n\npublic class ${cap(pkg)} {\n    public static String version() { return "${p.version}"; }\n${deps}}\n`);
    const cp = p.deps.map((d) => join(repo, 'ds', d, '1.0.0', `${d}-1.0.0.jar`)).join(':');
    await sh(`javac --release 11 -d out ${cp ? `-cp ${q(cp)}` : ''} src/ds/${pkg}/${cap(pkg)}.java`, dir);
    const target = join(repo, 'ds', p.name, p.version);
    await mkdir(target, { recursive: true });
    await sh(`jar cf ${q(join(target, `${p.name}-${p.version}.jar`))} -C out .`, dir);
    const depXml = p.deps.map((d) => `    <dependency><groupId>ds</groupId><artifactId>${d}</artifactId><version>1.0.0</version></dependency>`).join('\n');
    await put(target, `${p.name}-${p.version}.pom`, `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ds</groupId>
  <artifactId>${p.name}</artifactId>
  <version>${p.version}</version>
  <dependencies>
${depXml}
  </dependencies>
</project>
`);
  }
}

const JAVA_TEST = `package fixture;

import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class DepsTest {
    @Test
    public void deps() {
        String alpha = ds.alpha.Alpha.version(), beta = ds.beta.Beta.version();
        String gamma = ds.gamma.Gamma.version(), delta = ds.delta.Delta.version();
        String zeta = ds.epsilon.Epsilon.zeta(), eta = ds.epsilon.Epsilon.eta();
        assertFalse("ds-alpha 1.9.0 changed its API", alpha.equals("1.9.0"));
        assertFalse("ds-gamma 1.1.0 needs ds-delta 1.0", gamma.equals("1.1.0") && delta.equals("1.1.0"));
        assertFalse("ds-zeta 1.1.0 is broken", zeta.equals("1.1.0"));
        System.out.println(String.format("{\\"alpha\\":\\"%s\\",\\"beta\\":\\"%s\\",\\"gamma\\":\\"%s\\",\\"delta\\":\\"%s\\",\\"zeta\\":\\"%s\\",\\"eta\\":\\"%s\\"}",
            alpha, beta, gamma, delta, zeta, eta));
    }
}
`;

const jvmName = (n: string) => `ds:${n}`;

// --- Maven ---------------------------------------------------------------------------

const mavenEco: Ecosystem = {
  id: 'maven',
  scenarios: ['grouped'],
  async skip() {
    return (await has('mvn')) && (await has('javac')) ? false : 'maven or a JDK is not installed';
  },
  async make() {
    const root = await tmp('maven');
    const m2 = join(root, 'm2repo');
    const repo = join(root, 'repo');
    await publishJars(m2, join(root, 'work'), V2);
    const env = { MAVEN_ARGS: `-B -Dmaven.repo.local=${join(JVM_CACHE, 'm2')}` };
    await mkdir(repo, { recursive: true });
    const commit = await gitInit(repo);
    await put(repo, '.gitignore', 'target/\n');
    await put(repo, 'src/test/java/fixture/DepsTest.java', JAVA_TEST);
    // ds-alpha's version lives in a property, the others inline.
    const pom = (deps: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>fixture</groupId>
  <artifactId>app</artifactId>
  <version>0.0.0</version>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <alpha.version>${deps['ds-alpha']}</alpha.version>
  </properties>
  <repositories>
    <repository><id>depsect-fixture</id><url>file://${m2}</url></repository>
  </repositories>
  <dependencies>
    <dependency><groupId>ds</groupId><artifactId>ds-alpha</artifactId><version>\${alpha.version}</version></dependency>
${['ds-beta', 'ds-gamma', 'ds-delta', 'ds-epsilon'].map((n) => `    <dependency>\n      <groupId>ds</groupId>\n      <artifactId>${n}</artifactId>\n      <version>${deps[n]}</version>\n    </dependency>`).join('\n')}
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
  </dependencies>
</project>
`;
    await put(repo, 'pom.xml', pom(BEFORE));
    await commit('base');
    await put(repo, 'pom.xml', pom(AFTER));
    await commit('chore(deps): bump the group');
    return { repo, test: 'mvn -q test', install: 'true', env, name: jvmName, cleanup: async () => {} };
  },
};

// --- Gradle (multi-project: the dependencies live in app/, one via the catalog) -------

const gradleEco: Ecosystem = {
  id: 'gradle',
  scenarios: ['grouped'],
  async skip() {
    return (await has('gradle')) && (await has('javac')) ? false : 'gradle or a JDK is not installed';
  },
  async make() {
    const root = await tmp('gradle');
    const m2 = join(root, 'm2repo');
    const repo = join(root, 'repo');
    await publishJars(m2, join(root, 'work'), V2);
    const env = { GRADLE_USER_HOME: join(JVM_CACHE, 'gradle'), GRADLE_OPTS: '-Dorg.gradle.console=plain' };
    await mkdir(repo, { recursive: true });
    const commit = await gitInit(repo);
    await put(repo, '.gitignore', 'build/\n.gradle/\n');
    await put(repo, 'settings.gradle.kts', 'rootProject.name = "fixture"\ninclude("app")\n');
    await put(repo, 'app/src/test/java/fixture/DepsTest.java', JAVA_TEST);
    const catalog = (deps: Record<string, string>) =>
      `[versions]\nalpha = "${deps['ds-alpha']}"\n\n[libraries]\nds-alpha = { module = "ds:ds-alpha", version.ref = "alpha" }\n`;
    const build = (deps: Record<string, string>) => `plugins {
    java
}

repositories {
    maven { url = uri("file://${m2}") }
    mavenCentral()
}

dependencies {
    implementation(libs.ds.alpha)
${['ds-beta', 'ds-gamma', 'ds-delta', 'ds-epsilon'].map((n) => `    implementation("ds:${n}:${deps[n]}")`).join('\n')}
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    testLogging {
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
`;
    await put(repo, 'gradle/libs.versions.toml', catalog(BEFORE));
    await put(repo, 'app/build.gradle.kts', build(BEFORE));
    await commit('base');
    await put(repo, 'gradle/libs.versions.toml', catalog(AFTER));
    await put(repo, 'app/build.gradle.kts', build(AFTER));
    await commit('chore(deps): bump the group');
    return {
      repo,
      test: 'gradle test --rerun --no-daemon --warning-mode=none',
      install: 'true',
      env,
      name: jvmName,
      cleanup: async () => {
        await rm(join(repo, '.gradle'), { recursive: true, force: true });
      },
    };
  },
};

export const more: Ecosystem[] = [composerEco, bundlerEco, mavenEco, gradleEco];
