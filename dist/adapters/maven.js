// Maven: versions in pom.xml files, either inline (<version> in a
// <dependency>, <plugin>, <parent> or <extension>) or in <properties>
// referenced as ${name}. Multi-module builds are one project: every pom.xml
// below the root is read.
import { posix } from 'node:path';
import { mask, numbered, siteAdapter } from "./sites.js";
const POM = 'pom.xml';
/** Blank out comments and CDATA so tag scanning never looks inside them. */
const clean = (xml) => mask(mask(xml, /<!--[\s\S]*?-->/g), /<!\[CDATA\[[\s\S]*?\]\]>/g);
/** First direct `<tag>text</tag>` in a block whose nested structures have been masked. */
function child(block, offset, tag) {
    const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
    if (!m)
        return null;
    const start = offset + m.index + m[0].indexOf(m[1], tag.length + 2);
    return { text: m[1], start, end: start + m[1].length };
}
const KINDS = ['dependency', 'plugin', 'parent', 'extension'];
/** Coordinates ("group:artifact") that reference each ${property} as their version. */
function propertyUsers(xml) {
    const text = clean(xml);
    const users = new Map();
    for (const kind of KINDS) {
        for (const m of text.matchAll(new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`, 'g'))) {
            const block = mask(m[1], /<(exclusions|configuration|dependencies|executions)>[\s\S]*?<\/\1>/g);
            const version = /<version>\s*\$\{([^}]+)\}\s*<\/version>/.exec(block)?.[1];
            const artifact = child(block, 0, 'artifactId')?.text;
            if (!version || !artifact)
                continue;
            const group = child(block, 0, 'groupId')?.text ?? (kind === 'plugin' ? 'org.apache.maven.plugins' : '');
            users.set(version, [...(users.get(version) ?? []), `${group}:${artifact}`]);
        }
    }
    return users;
}
export function pomSites(xml) {
    const text = clean(xml);
    const sites = [];
    // <properties><name>value</name></properties>
    for (const props of text.matchAll(/<properties>([\s\S]*?)<\/properties>/g)) {
        const offset = props.index + '<properties>'.length;
        for (const m of props[1].matchAll(/<([A-Za-z0-9_.-]+)>([^<]*?)<\/\1>/g)) {
            const value = m[2].trim();
            if (!value)
                continue;
            const start = offset + m.index + m[0].indexOf(m[2]) + m[2].indexOf(value);
            sites.push({ name: `\${${m[1]}}`, section: 'property', value, start, end: start + value.length });
        }
    }
    // Inline versions. Nested exclusions, plugin configuration and plugin
    // dependencies are masked so only the block's own coordinates count.
    for (const kind of KINDS) {
        for (const m of text.matchAll(new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`, 'g'))) {
            const offset = m.index + kind.length + 2;
            const block = mask(m[1], /<(exclusions|configuration|dependencies|executions)>[\s\S]*?<\/\1>/g);
            const artifact = child(block, offset, 'artifactId');
            const version = child(block, offset, 'version');
            if (!artifact || !version || version.text.includes('${'))
                continue;
            const group = child(block, offset, 'groupId')?.text ?? (kind === 'plugin' ? 'org.apache.maven.plugins' : '');
            sites.push({ name: `${group}:${artifact.text}`, section: kind, value: version.text, start: version.start, end: version.end });
        }
    }
    return numbered(sites, (s) => `${s.section}:${s.name}`);
}
export const maven = siteAdapter({
    name: 'maven',
    files: [POM],
    detect: (head) => head[POM] != null,
    members: (_snap, paths) => paths.filter((p) => posix.basename(p) === POM && p !== POM && !/(^|\/)(target|node_modules)\//.test(p)),
    scans: (path) => posix.basename(path) === POM,
    sites: (_path, text) => pomSites(text),
    // A property used by exactly one artifact is named after it.
    rename(key, files) {
        const prop = /^property:\$\{(.+)\}#\d+$/.exec(key)?.[1];
        if (!prop)
            return undefined;
        const users = new Set(Object.values(files).flatMap((xml) => propertyUsers(xml).get(prop) ?? []));
        return users.size === 1 ? [...users][0] : undefined;
    },
    // Maven resolves dependencies as part of the build itself.
    install: 'true',
});
