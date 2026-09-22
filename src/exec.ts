import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run a shell command, capturing interleaved stdout/stderr. Never throws on non-zero exit. */
export function sh(command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
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
export async function shOk(command: string, opts: ExecOptions): Promise<string> {
  const res = await sh(command, opts);
  if (res.code !== 0) {
    throw new Error(`Command failed (exit ${res.code}): ${command}\n${res.output.trim()}`);
  }
  return res.output;
}
