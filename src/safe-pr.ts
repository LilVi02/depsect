// Open (or refresh) a pull request that contains only the updates depsect
// verified as safe, branched from the original PR's head commit.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Update } from './adapters/types.ts';
import { sh } from './exec.ts';
import { addWorktree } from './git.ts';
import type { RunReport } from './runner.ts';

type Api = (token: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export interface SafePrOptions {
  cwd: string;
  repo: string;
  token: string;
  headSha: string;
  baseRef: string;
  branch: string;
  /** Project directory relative to the repo root. */
  dir: string;
  /** Dependency files (relative to `dir`) in the safe state. */
  files: Record<string, string>;
  title: string;
  body: string;
  api: Api;
  log: (m: string) => void;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const row = (u: Update) => `| \`${u.name}\` | ${u.from ?? '_(new)_'} | ${u.to ?? '_(removed)_'} |`;
const tableOf = (us: Update[]) => ['| Package | From | To |', '| --- | --- | --- |', ...us.map(row)].join('\n');

export function safePrTitle(r: RunReport, pr: number): string {
  const n = r.result!.safe.length;
  return `chore(deps): apply ${n} verified update${n === 1 ? '' : 's'} from #${pr}`;
}

export function safePrBody(r: RunReport, pr: number): string {
  const res = r.result!;
  return [
    `This PR contains the updates from #${pr} that [depsect](https://github.com/LilVi02/depsect) verified to pass together.`,
    '',
    tableOf(res.safe),
    '',
    'Held back, because they break the build:',
    '',
    tableOf(res.culprits.flat()),
    '',
    `See #${pr} for the failing output. This branch is refreshed each time depsect runs on #${pr}.`,
  ].join('\n');
}

export interface SafePr {
  url: string;
  /** False when the branch was pushed but the PR could not be created; `url` then opens GitHub's compare page. */
  opened: boolean;
  hint?: string;
}

export async function openSafePr(o: SafePrOptions): Promise<SafePr> {
  const wt = await addWorktree(o.cwd, o.headSha);
  try {
    for (const [f, text] of Object.entries(o.files)) {
      const path = join(wt.path, o.dir, f);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    const git = async (args: string, secret = false) => {
      const res = await sh(`git ${args}`, { cwd: wt.path });
      // Never echo a command that carries the token.
      if (res.code !== 0) throw new Error(secret ? `git push failed:\n${res.output.split(o.token).join('***')}` : `git ${args} failed:\n${res.output}`);
      return res.output;
    };
    await git('add -A');
    if (!(await git('status --porcelain')).trim()) throw new Error('the safe updates produce no change');
    await git(
      `-c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -q -m ${q(o.title)}`,
    );
    const server = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/^https:\/\//, '');
    const url = `https://x-access-token:${o.token}@${server}/${o.repo}.git`;
    // Bypass the credentials actions/checkout stored, so a custom token is actually used.
    await git(`-c http.https://${server}/.extraheader= push --force -q ${q(url)} HEAD:refs/heads/${o.branch}`, true);
    o.log(`Pushed ${o.branch}`);
  } finally {
    await wt.dispose();
  }

  const owner = o.repo.split('/')[0];
  const open = (await o.api(o.token, 'GET', `/repos/${o.repo}/pulls?state=open&head=${owner}:${o.branch}`)) as { number: number; html_url: string }[];
  if (open[0]) {
    await o.api(o.token, 'PATCH', `/repos/${o.repo}/pulls/${open[0].number}`, { title: o.title, body: o.body });
    return { url: open[0].html_url, opened: true };
  }
  try {
    const created = (await o.api(o.token, 'POST', `/repos/${o.repo}/pulls`, {
      title: o.title,
      body: o.body,
      head: o.branch,
      base: o.baseRef,
    })) as { html_url: string };
    return { url: created.html_url, opened: true };
  } catch (err) {
    // Repositories disallow PRs from GITHUB_TOKEN by default. The branch is
    // pushed, so link GitHub's compare page, prefilled, instead.
    if (!/not permitted to create or approve pull requests/.test((err as Error).message)) throw err;
    const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
    const params = new URLSearchParams({ expand: '1', title: o.title, body: o.body });
    return {
      url: `${server}/${o.repo}/compare/${o.baseRef}...${o.branch}?${params}`,
      opened: false,
      hint:
        'GitHub Actions is not allowed to create pull requests in this repository. Enable "Allow GitHub Actions to create ' +
        'and approve pull requests" in Settings → Actions → General, or pass a pr-token.',
    };
  }
}
