// GitHub Action entrypoint. No @actions/* dependencies: inputs come from
// INPUT_* env vars, outputs go to $GITHUB_OUTPUT, and GitHub is plain REST.
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePrBody, safePrTitle, openSafePr } from "./safe-pr.js";
import { COMMENT_MARKER, toMarkdown } from "./report.js";
import { run } from "./runner.js";
const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const bool = (name) => input(name).toLowerCase() === 'true';
async function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file)
        return;
    const delim = `ghadelim_${randomUUID()}`;
    await appendFile(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}
async function gh(token, method, path, body) {
    const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    const res = await fetch(`${api}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok)
        throw new Error(`GitHub API ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
}
/** Create the report comment, or update the one from a previous run. */
async function upsertComment(token, repo, pr, body) {
    const comments = (await gh(token, 'GET', `/repos/${repo}/issues/${pr}/comments?per_page=100`));
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (existing)
        await gh(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
    else
        await gh(token, 'POST', `/repos/${repo}/issues/${pr}/comments`, { body });
}
async function main() {
    const event = process.env.GITHUB_EVENT_PATH
        ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
        : {};
    const pr = event.pull_request;
    const repo = process.env.GITHUB_REPOSITORY;
    const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const test = input('test-command');
    if (!test)
        throw new Error('Input "test-command" is required');
    const base = input('base') || pr?.base.sha;
    if (!base)
        throw new Error('Input "base" is required outside pull_request events');
    const timeout = Number(input('timeout-minutes'));
    const transitive = (input('transitive') || 'auto');
    if (!['auto', 'always', 'never'].includes(transitive))
        throw new Error('Input "transitive" must be auto, always or never');
    const dir = input('working-directory') || '.';
    const report = await run({
        cwd: workspace,
        base,
        head: input('head') || 'HEAD',
        dir,
        test,
        install: input('install-command') || undefined,
        retries: Number(input('retries') || '0'),
        timeoutMs: timeout > 0 ? timeout * 60_000 : undefined,
        transitive,
        applySafe: bool('apply-safe'),
        log: (m) => console.log(m),
    });
    const token = input('github-token');
    let safePr;
    if (bool('open-pr') && report.status === 'found' && report.result.safe.length > 0) {
        if (!pr || !repo) {
            console.log('::warning::open-pr only works on pull_request events.');
        }
        else if (pr.head.repo?.full_name !== repo) {
            console.log('::warning::open-pr is skipped for pull requests from forks.');
        }
        else {
            try {
                safePr = await openSafePr({
                    cwd: workspace,
                    repo,
                    token: input('pr-token') || token,
                    headSha: pr.head.sha,
                    baseRef: pr.base.ref,
                    branch: `depsect/safe-updates-${pr.number}`,
                    dir,
                    files: report.safeFiles ?? {},
                    title: safePrTitle(report, pr.number),
                    body: safePrBody(report, pr.number),
                    api: gh,
                    log: (m) => console.log(m),
                });
                console.log(`Opened ${safePr}`);
            }
            catch (err) {
                console.log(`::warning::Could not open the safe-updates PR: ${err.message}`);
            }
        }
    }
    const md = toMarkdown(report, test, { safePr });
    if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
    const names = (xs) => xs.map((u) => u.name);
    await setOutput('status', report.status);
    await setOutput('culprits', JSON.stringify(report.result?.culprits.map(names) ?? []));
    await setOutput('safe', JSON.stringify(names(report.result?.safe ?? [])));
    await setOutput('safe-pr', safePr ?? '');
    if (bool('comment') && token && pr && repo && report.status !== 'no-updates') {
        try {
            await upsertComment(token, repo, pr.number, md);
        }
        catch (err) {
            // Dependabot-triggered runs get a read-only token unless permissions are granted.
            console.log(`::warning::Could not comment on the PR (${err.message}). The report is in the job summary.`);
        }
    }
    if (report.status === 'found' && bool('fail-on-culprit')) {
        const list = report.result.culprits.map((c) => names(c).join(' + ')).join(', ');
        console.log(`::error::depsect: dependency update(s) broke the build: ${list}`);
        process.exitCode = 1;
    }
}
main().catch((err) => {
    console.log(`::error::depsect: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
});
