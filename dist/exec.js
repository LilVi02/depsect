import { spawn } from 'node:child_process';
/** Run a shell command, capturing interleaved stdout/stderr. Never throws on non-zero exit. */
export function sh(command, opts) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks = [];
        child.stdout.on('data', (c) => chunks.push(c));
        child.stderr.on('data', (c) => chunks.push(c));
        let timedOut = false;
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, opts.timeoutMs)
            : undefined;
        child.on('error', reject);
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            resolve({
                code: code ?? 1,
                output: Buffer.concat(chunks).toString('utf8'),
                timedOut,
                durationMs: Date.now() - started,
            });
        });
    });
}
/** Run a command that is expected to succeed; throw with its output otherwise. */
export async function shOk(command, opts) {
    const res = await sh(command, opts);
    if (res.code !== 0) {
        throw new Error(`Command failed (exit ${res.code}): ${command}\n${res.output.trim()}`);
    }
    return res.output;
}
