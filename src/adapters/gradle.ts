// Gradle: versions in version catalogs (gradle/*.versions.toml) and as
// literals in build scripts ("group:artifact:version" strings and plugin
// `version "x"` clauses, Groovy or Kotlin DSL). A multi-project build is one
// project: every build script below the root is read.
import { posix } from 'node:path';
import { headerPath } from '../toml.ts';
import { mask, numbered, siteAdapter, type Site } from './sites.ts';

const BUILD = /(^|\/)build\.gradle(\.kts)?$/;
const SETTINGS = ['settings.gradle', 'settings.gradle.kts'];
const CATALOG = /(^|\/)gradle\/[^/]+\.versions\.toml$/;

export function catalogSites(toml: string): Site[] {
  const sites: Omit<Site, 'key'>[] = [];
  let section = '';
  let offset = 0;
  for (const line of toml.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const header = headerPath(line);
    if (header) {
      section = header.join('.');
      continue;
    }
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line.replace(/#.*$/, ''));
    if (!m) continue;
    const alias = m[1]!;
    const rhs = m[2]!;
    const rhsAt = lineStart + line.indexOf(rhs, line.indexOf('=') + 1);
    const at = (value: string, index: number) => ({ value, start: rhsAt + index, end: rhsAt + index + value.length });

    if (section === 'versions') {
      // alias = "1.2.3", or a rich version { strictly/require/prefer = "…" }
      const q = /^\s*"([^"]+)"/.exec(rhs) ?? /(?:strictly|require|prefer)\s*=\s*"([^"]+)"/.exec(rhs);
      if (q) sites.push({ name: alias, section: 'catalog', ...at(q[1]!, q.index + q[0].indexOf(q[1]!)) });
    } else if (section === 'libraries' || section === 'plugins') {
      const kind = section === 'libraries' ? 'library' : 'plugin';
      // "group:artifact:1.2.3" or "plugin.id:1.2.3"
      const short = /^\s*"([^"]+):([^":]+)"/.exec(rhs);
      if (short) {
        sites.push({ name: short[1]!, section: kind, ...at(short[2]!, short.index + short[0].lastIndexOf(short[2]!)) });
        continue;
      }
      // { module = "g:a", version = "1.2.3" } / { group = …, name = …, version = … } / { id = …, version = … }
      const version = /\bversion\s*=\s*"([^"]+)"/.exec(rhs);
      if (!version) continue;
      const module = /\bmodule\s*=\s*"([^"]+)"/.exec(rhs)?.[1];
      const group = /\bgroup\s*=\s*"([^"]+)"/.exec(rhs)?.[1];
      const artifact = /\bname\s*=\s*"([^"]+)"/.exec(rhs)?.[1];
      const id = /\bid\s*=\s*"([^"]+)"/.exec(rhs)?.[1];
      const name = module ?? (group && artifact ? `${group}:${artifact}` : id ?? alias);
      sites.push({ name, section: kind, ...at(version[1]!, version.index + version[0].lastIndexOf(version[1]!)) });
    }
  }
  return numbered(sites, (s) => `${s.section}:${s.name}`);
}

/** Catalog version aliases referenced as version.ref, and the libraries/plugins that use them. */
function versionRefs(toml: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const m of toml.matchAll(/^\s*[A-Za-z0-9_.-]+\s*=\s*\{([^}]*)\}/gm)) {
    const ref = /version\.ref\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? /version\s*=\s*\{\s*ref\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1];
    if (!ref) continue;
    const module = /\bmodule\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? /\bid\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1];
    if (module) refs.set(ref, [...(refs.get(ref) ?? []), module]);
  }
  return refs;
}

export function scriptSites(script: string): Site[] {
  // Ignore comments; keep offsets.
  const text = mask(mask(script, /\/\*[\s\S]*?\*\//g), /\/\/[^\n]*/g);
  const sites: Omit<Site, 'key'>[] = [];
  // "group:artifact:version" (optionally ":classifier" / "@ext"), no interpolation.
  for (const m of text.matchAll(/(["'])([\w.-]+):([\w.-]+):([\w.+-]+)(?::[\w.-]+)?(?:@\w+)?\1/g)) {
    const value = m[4]!;
    const start = m.index! + 1 + m[2]!.length + 1 + m[3]!.length + 1;
    sites.push({ name: `${m[2]}:${m[3]}`, section: 'dependency', value, start, end: start + value.length });
  }
  // Plugins: id("x") version "1.2.3", id 'x' version '1.2.3', kotlin("jvm") version "2.0.0".
  for (const m of text.matchAll(/\b(id|kotlin)\s*\(?\s*(["'])([\w.-]+)\2\s*\)?\s+version\s*\(?\s*(["'])([\w.+-]+)\4/g)) {
    const name = m[1] === 'kotlin' ? `org.jetbrains.kotlin.${m[3]}` : m[3]!;
    const value = m[5]!;
    const start = m.index! + m[0].lastIndexOf(value);
    sites.push({ name, section: 'plugin', value, start, end: start + value.length });
  }
  return numbered(sites, (s) => `${s.section}:${s.name}`);
}

export const gradle = siteAdapter({
  name: 'gradle',
  files: [...SETTINGS, 'build.gradle', 'build.gradle.kts', 'gradle/libs.versions.toml'],
  detect: (head) => [...SETTINGS, 'build.gradle', 'build.gradle.kts'].some((f) => head[f] != null),
  members: (_snap, paths) =>
    paths.filter((p) => (BUILD.test(p) || CATALOG.test(p)) && !/(^|\/)(build|\.gradle|node_modules)\//.test(p)),
  scans: (path) => BUILD.test(path) || CATALOG.test(path),
  sites: (path, text) => (CATALOG.test(path) ? catalogSites(text) : scriptSites(text)),
  // A catalog version used by exactly one library or plugin is named after it.
  rename(key, files) {
    const alias = /^catalog:(.+)#\d+$/.exec(key)?.[1];
    if (!alias) return undefined;
    const users = new Set(Object.entries(files).filter(([f]) => CATALOG.test(f)).flatMap(([, t]) => versionRefs(t).get(alias) ?? []));
    return users.size === 1 ? [...users][0] : undefined;
  },
  // Gradle resolves dependencies as part of the build itself.
  install: 'true',
});
