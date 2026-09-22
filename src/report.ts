import type { Update } from './adapters/types.ts';
import type { RunReport } from './runner.ts';

export const COMMENT_MARKER = '<!-- depsect-report -->';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const ver = (u: Update) => [u.from ?? '_(new)_', u.to ?? '_(removed)_'];

const label = (u: Update) => `\`${u.name}\`${u.kind === 'transitive' ? ' <sub>transitive</sub>' : ''}`;

function table(updates: Update[]): string {
  const rows = updates.map((u) => {
    const [from, to] = ver(u);
    return `| ${label(u)} | ${from} | ${to} |`;
  });
  return ['| Package | From | To |', '| --- | --- | --- |', ...rows].join('\n');
}

function details(summary: string, body: string): string {
  if (!body.trim()) return '';
  // Break out of the fence if the output itself contains one.
  const fence = body.includes('```') ? '````' : '```';
  return `<details><summary>${summary}</summary>\n\n${fence}text\n${body}\n${fence}\n\n</details>`;
}

export interface MarkdownExtras {
  /** URL of the pull request opened with the safe updates. */
  safePr?: string;
}

export function toMarkdown(r: RunReport, testCommand: string, extras: MarkdownExtras = {}): string {
  const out: string[] = [COMMENT_MARKER];
  const footer = (runs?: number) =>
    `<sub>${runs !== undefined ? `${plural(runs, 'run')} · ` : ''}${formatDuration(r.durationMs)} · ` +
    `${r.adapter} · [depsect](https://github.com/LilVi02/depsect)</sub>`;

  switch (r.status) {
    case 'no-updates':
      out.push('## depsect: no dependency updates found', '', `The manifests are the same at \`${r.base.slice(0, 7)}\` and \`${r.head.slice(0, 7)}\`.`);
      break;

    case 'no-failure':
      out.push(
        '## ✅ depsect: all updates pass',
        '',
        r.excluded.length
          ? `\`${testCommand}\` passes with all ${plural(r.updates.length, 'update')} depsect could apply. The failure may come from a change it could not isolate (listed below), or be flaky.`
          : `\`${testCommand}\` passes with all ${plural(r.updates.length, 'update')} applied, so the failure is probably flaky or unrelated to dependencies.`,
      );
      break;

    case 'base-broken':
      out.push(
        '## ⚠️ depsect: the build fails even without the updates',
        '',
        `\`${testCommand}\` already fails with the dependencies from \`${r.base.slice(0, 7)}\`, so the dependency updates are not the cause.`,
        '',
        details('Failing output', r.culpritLogs[0] ?? ''),
      );
      break;

    case 'found': {
      const res = r.result!;
      const bad = res.culprits.flat().length;
      out.push(
        `## 🔎 depsect: ${plural(bad, 'update')} out of ${r.updates.length} broke the build`,
        '',
      );
      res.culprits.forEach((set, i) => {
        if (res.culprits.length > 1) out.push(`### Culprit ${i + 1}`, '');
        out.push(
          set.length === 1
            ? `This update makes \`${testCommand}\` fail:`
            : `These updates pass **on their own** but break \`${testCommand}\` **together**:`,
          '',
          table(set),
          '',
          details('Failing output', r.culpritLogs[i] ?? ''),
          '',
        );
      });
      if (res.safe.length > 0) {
        out.push(
          `✅ **The other ${plural(res.safe.length, 'update')} pass together** (verified):`,
          '',
          `<details><summary>Show safe updates</summary>\n\n${table(res.safe)}\n\n</details>`,
          '',
        );
      }
      if (extras.safePr) out.push(`➡️ Opened ${extras.safePr} with just the safe updates.`, '');
      if (r.appliedSafe) out.push('The safe updates have been written to the working tree.', '');
      break;
    }
  }

  if (r.excluded.length) {
    out.push('', `> [!WARNING]\n> ${plural(r.excluded.length, 'change')} could not be tested on its own and ${r.excluded.length === 1 ? 'was' : 'were'} left out: ${r.excluded.map((e) => `\`${e}\``).join(', ')}`);
  }
  for (const n of r.notes) out.push('', `> [!NOTE]\n> ${n}`);
  out.push('', footer(r.result?.runs));
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** The few lines of a failure excerpt worth showing in a terminal. */
function highlights(log: string, max = 6): string[] {
  const lines = log.split('\n').filter((l) => !l.startsWith('$ '));
  const hits = lines.filter((l) => /\b(not ok|FAIL(ED)?)\b|error|Error|expected|actual|[✕✖×●]/.test(l));
  return (hits.length ? hits : lines).slice(0, max).map((l) => l.trim());
}

export interface Paint {
  red: (s: string) => string;
  green: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
}

const sgr = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
export const colors: Paint = { red: sgr(31, 39), green: sgr(32, 39), bold: sgr(1, 22), dim: sgr(2, 22) };
export const noColors: Paint = { red: (s) => s, green: (s) => s, bold: (s) => s, dim: (s) => s };

export function toTerminal(r: RunReport, testCommand: string, c: Paint = noColors): string {
  const line = (u: Update) =>
    `  ${c.bold(u.name)}  ${u.from ?? '(new)'} → ${u.to ?? '(removed)'}${u.kind === 'transitive' ? c.dim('  (transitive)') : ''}`;
  const out: string[] = [''];
  switch (r.status) {
    case 'no-updates':
      out.push('No dependency updates between base and head.');
      break;
    case 'no-failure':
      out.push(
        r.excluded.length
          ? `All ${plural(r.updates.length, 'update')} depsect could apply pass together. The failure may come from a change it could not isolate:`
          : `All ${plural(r.updates.length, 'update')} pass together. The failure is not caused by dependencies.`,
      );
      break;
    case 'base-broken':
      out.push(`'${testCommand}' already fails without any updates. Nothing to bisect.`, '', r.culpritLogs[0] ?? '');
      break;
    case 'found': {
      const res = r.result!;
      res.culprits.forEach((set, i) => {
        out.push(c.red(c.bold(set.length === 1 ? 'CULPRIT:' : 'CULPRIT (only fails in combination):')));
        out.push(...set.map(line));
        if (r.culpritLogs[i]) out.push(...highlights(r.culpritLogs[i]!).map((l) => c.dim(`  │ ${l}`)));
        out.push('');
      });
      if (res.safe.length) out.push(c.green(c.bold(`SAFE (${res.safe.length}, verified together):`)), ...res.safe.map(line));
      out.push('', c.dim(`${plural(res.runs, 'run')} in ${formatDuration(r.durationMs)}`));
    }
  }
  if (r.excluded.length) out.push('', c.dim('not isolated:'), ...r.excluded.map((e) => c.dim(`  ${e}`)));
  for (const n of r.notes) out.push('', c.dim(`note: ${n}`));
  return out.join('\n');
}
