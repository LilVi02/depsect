// Records a real depsect run as an asciicast, then renders it to docs/demo.svg.
//   node scripts/record-demo.mjs <path-to-demo-repo> [base-ref]
// The run is real; only the waiting (npm install + tests) is compressed so the
// animation stays short.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [repo, base = 'main'] = process.argv.slice(2);
if (!repo) throw new Error('usage: record-demo.mjs <demo-repo> [base]');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const shown = `depsect --base ${base} --test "npm test"`;
const MAX_GAP = 0.45; // seconds

const events = [];
let t = 0.6;
for (const ch of `$ ${shown}`) events.push([(t += 0.045), 'o', ch]);
events.push([(t += 0.4), 'o', '\r\n']);

const child = spawn('script', ['-q', '/dev/null', 'node', cli, '--base', base, '--test', 'npm test'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let last = Date.now();
child.stdout.on('data', (buf) => {
  const now = Date.now();
  t += Math.min((now - last) / 1000, MAX_GAP);
  last = now;
  events.push([t, 'o', buf.toString('utf8')]);
});
child.on('close', () => {
  events.push([t + 5, 'o', '']); // hold the final frame
  const header = { version: 2, width: 92, height: 44, env: { TERM: 'xterm-256color', SHELL: '/bin/zsh' } };
  const cast = [JSON.stringify(header), ...events.map((e) => JSON.stringify([+e[0].toFixed(3), e[1], e[2]]))].join('\n') + '\n';
  const castPath = fileURLToPath(new URL('../docs/demo.cast', import.meta.url));
  writeFileSync(castPath, cast);
  execSync(`npx --yes svg-term-cli@2 --in "${castPath}" --out docs/demo.svg --window --padding 18`, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  });
  console.log(`wrote docs/demo.cast and docs/demo.svg (${t.toFixed(1)}s)`);
});
