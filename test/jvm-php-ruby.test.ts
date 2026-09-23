// Composer, Bundler, Maven and Gradle: parsing, diffs and edits, on real
// lockfiles (Composer 2.10, Bundler 2.6) and realistic build files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundler, parseGemfileLock, revertGemfile, revertGems, serializeGemfileLock } from '../src/adapters/bundler.ts';
import { composeComposerLock, composer } from '../src/adapters/composer.ts';
import { catalogSites, gradle, scriptSites } from '../src/adapters/gradle.ts';
import { maven, pomSites } from '../src/adapters/maven.ts';

const read = (f: string) => readFileSync(new URL(`./lockfiles/${f}`, import.meta.url), 'utf8');
const tmp = () => mkdtemp(join(tmpdir(), 'depsect-unit-'));

// --- Composer -------------------------------------------------------------------

test('composer: recomposing an unchanged lock gives back the same bytes', () => {
  assert.equal(composeComposerLock(read('composer.lock'), read('composer.lock'), new Set(), JSON.parse(read('composer.json'))), read('composer.lock'));
});

test('composer: diff and composition', () => {
  const lock = JSON.parse(read('composer.lock'));
  const bump = (name: string, v: string) => {
    const l = structuredClone(lock);
    for (const p of [...l.packages, ...l['packages-dev']]) if (p.name === name) p.version = v;
    return l;
  };
  const base = { 'composer.json': read('composer.json'), 'composer.lock': read('composer.lock') };
  const headLock = bump('psr/log', '3.9.9');
  headLock.packages.find((p: { name: string }) => p.name === 'monolog/monolog').version = '3.99.0';
  const head = { ...base, 'composer.lock': JSON.stringify(headLock, null, 4) + '\n' };
  const { updates } = composer.diff(base, head);
  assert.deepEqual(updates.map((u) => [u.name, u.kind, u.to]), [['monolog/monolog', 'direct', '3.99.0'], ['psr/log', 'direct', '3.9.9']]);

  const composed = JSON.parse(composeComposerLock(base['composer.lock'], head['composer.lock'], new Set(['psr/log']), JSON.parse(read('composer.json'))));
  const v = (n: string) => composed.packages.find((p: { name: string }) => p.name === n)?.version;
  assert.equal(v('psr/log'), '3.9.9');
  assert.equal(v('monolog/monolog'), lock.packages.find((p: { name: string }) => p.name === 'monolog/monolog').version);
  assert.equal(composed['content-hash'], headLock['content-hash']);
});

// --- Bundler --------------------------------------------------------------------

test('bundler: Gemfile.lock round-trips byte for byte', () => {
  assert.equal(serializeGemfileLock(parseGemfileLock(read('Gemfile.lock'))), read('Gemfile.lock'));
  const gem = parseGemfileLock(read('Gemfile.lock')).find((s) => s.header === 'GEM')!;
  const noko = gem.specs.filter((s) => s.name === 'nokogiri');
  assert.equal(noko.length, 8, 'one spec per platform build');
  assert.ok(noko.every((s) => s.version === '1.19.4' && s.deps.includes('racc')));
});

test('bundler: diff and revert across specs, DEPENDENCIES, CHECKSUMS and the Gemfile', async () => {
  const baseLock = read('Gemfile.lock');
  const headLock = baseLock.replace(/nokogiri \(1\.19\.4/g, 'nokogiri (1.20.0').replace(/rack \(3\.2\.7\)/g, 'rack (3.3.0)').replace(/racc \(1\.8\.1\)/g, 'racc (1.9.0)');
  const baseGemfile = read('Gemfile');
  const headGemfile = baseGemfile.replace('gem "nokogiri", "~> 1.16"', 'gem "nokogiri", "~> 1.20"');
  const base = { Gemfile: baseGemfile, 'Gemfile.lock': baseLock };
  const head = { Gemfile: headGemfile, 'Gemfile.lock': headLock };
  assert.deepEqual(bundler.diff(base, head).updates.map((u) => [u.name, u.kind, u.from, u.to]), [
    ['nokogiri', 'direct', '1.19.4', '1.20.0'],
    ['racc', 'transitive', '1.8.1', '1.9.0'],
    ['rack', 'direct', '3.2.7', '3.3.0'],
  ]);

  const out = revertGems(baseLock, headLock, new Set(['nokogiri']));
  assert.equal(out.match(/nokogiri \(1\.19\.4/g)!.length, 16, '8 specs + 8 checksums back to base');
  assert.ok(!out.includes('nokogiri (1.20.0'));
  assert.ok(out.includes('rack (3.3.0)') && out.includes('racc (1.9.0)'));
  assert.equal(revertGems(baseLock, headLock, new Set()), headLock);
  assert.equal(revertGemfile(baseGemfile, headGemfile, new Set(['nokogiri'])), baseGemfile);

  const dir = await tmp();
  await bundler.write(dir, base, head, bundler.diff(base, head).updates.filter((u) => u.name === 'rack'));
  const written = await readFile(join(dir, 'Gemfile.lock'), 'utf8');
  assert.ok(written.includes('rack (3.3.0)') && written.includes('nokogiri (1.19.4-arm64-darwin)') && written.includes('racc (1.8.1)'));
  assert.equal(await readFile(join(dir, 'Gemfile'), 'utf8'), baseGemfile);
});

// --- Maven ----------------------------------------------------------------------

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
  <properties>
    <java.version>21</java.version>
    <jackson.version>2.17.1</jackson.version>
    <guava.version>33.2.0-jre</guava.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-core</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>\${guava.version}</version>
      <exclusions>
        <exclusion><groupId>com.google.code.findbugs</groupId><artifactId>jsr305</artifactId></exclusion>
      </exclusions>
    </dependency>
    <!-- <dependency><groupId>x</groupId><artifactId>y</artifactId><version>9.9</version></dependency> -->
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.13</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
        <configuration><version>not-a-dependency</version></configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

test('maven: finds versions inline, in properties and in plugins, not in comments or configuration', () => {
  const sites = pomSites(POM);
  const at = (key: string) => sites.find((s) => s.key === key);
  assert.deepEqual(sites.map((s) => `${s.key}=${s.value}`).sort(), [
    'dependency:org.slf4j:slf4j-api#0=2.0.13',
    'parent:org.springframework.boot:spring-boot-starter-parent#0=3.3.0',
    'plugin:org.apache.maven.plugins:maven-surefire-plugin#0=3.2.5',
    'property:${guava.version}#0=33.2.0-jre',
    'property:${jackson.version}#0=2.17.1',
    'property:${java.version}#0=21',
  ]);
  const slf4j = at('dependency:org.slf4j:slf4j-api#0')!;
  assert.equal(POM.slice(slf4j.start, slf4j.end), '2.0.13');
  const jackson = at('property:${jackson.version}#0')!;
  assert.equal(POM.slice(jackson.start, jackson.end), '2.17.1');
});

test('maven: diff names properties after the artifact using them, and write reverts outside the subset', async () => {
  const head = POM.replace('2.17.1', '2.18.0').replace('33.2.0-jre', '33.3.0-jre').replace('2.0.13', '2.0.16');
  const updates = maven.diff({ 'pom.xml': POM }, { 'pom.xml': head }).updates;
  assert.deepEqual(updates.map((u) => [u.name, u.from, u.to]), [
    ['${jackson.version}', '2.17.1', '2.18.0'], // used by two artifacts
    ['com.google.guava:guava', '33.2.0-jre', '33.3.0-jre'],
    ['org.slf4j:slf4j-api', '2.0.13', '2.0.16'],
  ]);
  const dir = await tmp();
  await maven.write(dir, { 'pom.xml': POM }, { 'pom.xml': head }, updates.filter((u) => u.name === 'com.google.guava:guava'));
  assert.equal(await readFile(join(dir, 'pom.xml'), 'utf8'), POM.replace('33.2.0-jre', '33.3.0-jre'));
});

test('maven: modules are members; build output is not', () => {
  assert.deepEqual(maven.members!({}, ['pom.xml', 'core/pom.xml', 'web/pom.xml', 'web/target/classes/META-INF/pom.xml', 'README.md']), [
    'core/pom.xml',
    'web/pom.xml',
  ]);
});

// --- Gradle ---------------------------------------------------------------------

const CATALOG = `[versions]
kotlin = "2.0.0"
ktor = "2.3.11"
junit = { strictly = "5.10.2" }

[libraries]
ktor-core = { module = "io.ktor:ktor-server-core", version.ref = "ktor" }
guava = "com.google.guava:guava:33.2.0-jre"
slf4j = { group = "org.slf4j", name = "slf4j-api", version = "2.0.13" }
junit = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }

[plugins]
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
shadow = { id = "com.github.johnrengelman.shadow", version = "8.1.1" }
`;

test('gradle: catalog versions, libraries and plugins', () => {
  const sites = catalogSites(CATALOG);
  assert.deepEqual(sites.map((s) => `${s.key}=${s.value}`), [
    'catalog:kotlin#0=2.0.0',
    'catalog:ktor#0=2.3.11',
    'catalog:junit#0=5.10.2',
    'library:com.google.guava:guava#0=33.2.0-jre',
    'library:org.slf4j:slf4j-api#0=2.0.13',
    'plugin:com.github.johnrengelman.shadow#0=8.1.1',
  ]);
  for (const s of sites) assert.equal(CATALOG.slice(s.start, s.end), s.value);
});

const SCRIPT = `plugins {
    kotlin("jvm") version "2.0.0"
    id("com.diffplug.spotless") version "6.25.0"
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:\${coroutinesVersion}")
    // implementation("com.example:old:1.0.0")
    testImplementation('junit:junit:4.13.2')
    implementation(libs.guava)
}
`;

test('gradle: build script coordinates and plugin versions, not interpolations or comments', () => {
  const sites = scriptSites(SCRIPT);
  assert.deepEqual(sites.map((s) => `${s.key}=${s.value}`), [
    'dependency:com.squareup.okhttp3:okhttp#0=4.12.0',
    'dependency:junit:junit#0=4.13.2',
    'plugin:org.jetbrains.kotlin.jvm#0=2.0.0',
    'plugin:com.diffplug.spotless#0=6.25.0',
  ]);
  for (const s of sites) assert.equal(SCRIPT.slice(s.start, s.end), s.value);
});

test('gradle: diff names catalog versions after their single user; write reverts outside the subset', async () => {
  const base = { 'build.gradle.kts': SCRIPT, 'gradle/libs.versions.toml': CATALOG };
  const head = {
    'build.gradle.kts': SCRIPT.replace('4.12.0', '4.12.1'),
    'gradle/libs.versions.toml': CATALOG.replace('ktor = "2.3.11"', 'ktor = "2.3.12"').replace('33.2.0-jre', '33.3.0-jre'),
  };
  const updates = gradle.diff(base, head).updates;
  assert.deepEqual(updates.map((u) => [u.name, u.section, u.to]), [
    ['com.google.guava:guava', 'library', '33.3.0-jre'],
    ['com.squareup.okhttp3:okhttp', 'dependency', '4.12.1'],
    ['io.ktor:ktor-server-core', 'catalog', '2.3.12'],
  ]);
  const dir = await tmp();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'gradle'));
  await gradle.write(dir, base, head, updates.filter((u) => u.name === 'io.ktor:ktor-server-core'));
  assert.equal(await readFile(join(dir, 'build.gradle.kts'), 'utf8'), SCRIPT);
  assert.equal(await readFile(join(dir, 'gradle/libs.versions.toml'), 'utf8'), CATALOG.replace('ktor = "2.3.11"', 'ktor = "2.3.12"'));
});
