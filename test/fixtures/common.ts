// Shared pieces for the offline end-to-end fixtures: the package universe,
// a store-only zip writer (for wheels and Go modules), a static HTTP server
// (for the fake npm registry and PyPI index), and a git repo helper.
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { crc32 } from 'node:zlib';
import { shOk } from '../../src/exec.ts';

export interface Pkg {
  name: string;
  version: string;
  /** name → allowed major (the fixtures express this as ^1 / >=1,<2 / "1"). */
  deps: string[];
}

const p = (name: string, version: string, deps: string[] = []): Pkg => ({ name, version, deps });

/**
 * The same universe for every ecosystem:
 *   ds-alpha 1.9.0 breaks the build on its own
 *   ds-gamma 1.1.0 + ds-delta 1.1.0 break it only together
 *   ds-beta 1.1.0 is harmless
 *   ds-epsilon (never updated) pulls in ds-zeta and ds-eta;
 *   ds-zeta 1.1.0 breaks the build, ds-eta 1.1.0 is harmless
 */
export const V1: Pkg[] = [
  p('ds-alpha', '1.0.0'),
  p('ds-beta', '1.0.0'),
  p('ds-gamma', '1.0.0'),
  p('ds-delta', '1.0.0'),
  p('ds-epsilon', '1.0.0', ['ds-zeta', 'ds-eta']),
  p('ds-zeta', '1.0.0'),
  p('ds-eta', '1.0.0'),
];
export const V2: Pkg[] = [
  ...V1,
  p('ds-alpha', '1.9.0'),
  p('ds-beta', '1.1.0'),
  p('ds-gamma', '1.1.0'),
  p('ds-delta', '1.1.0'),
  p('ds-zeta', '1.1.0'),
  p('ds-eta', '1.1.0'),
];

/** Direct dependencies with exact pins, before and after the grouped update. */
export const BEFORE: Record<string, string> = { 'ds-alpha': '1.0.0', 'ds-beta': '1.0.0', 'ds-gamma': '1.0.0', 'ds-delta': '1.0.0', 'ds-epsilon': '1.0.0' };
export const AFTER: Record<string, string> = { ...BEFORE, 'ds-alpha': '1.9.0', 'ds-beta': '1.1.0', 'ds-gamma': '1.1.0', 'ds-delta': '1.1.0' };


// --- zip ---------------------------------------------------------------------

/** A minimal store-only (uncompressed) zip archive. */
export function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// --- static server -----------------------------------------------------------

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Serve `root` over HTTP on 127.0.0.1. A directory serves its index.html or index.json. */
export async function serve(root: string): Promise<StaticServer> {
  const server: Server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    try {
      if ((await stat(file)).isDirectory()) {
        file = join(file, 'index.html');
        if (!(await stat(file).catch(() => null))) file = file.replace(/index\.html$/, 'index.json');
      }
      const body = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html' : /\.(tgz|whl|zip)$/.test(file) ? 'application/octet-stream' : 'application/json';
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Package managers keep connections alive; close() would wait for them.
        server.closeAllConnections();
      }),
  };
}

// --- git ---------------------------------------------------------------------

export async function gitInit(dir: string) {
  const git = (cmd: string) => shOk(`git ${cmd}`, { cwd: dir });
  await git('init -q -b main');
  await git('config user.email test@example.com');
  await git('config user.name test');
  return async (message: string) => {
    await git('add -A');
    await git(`commit -q -m ${JSON.stringify(message)}`);
  };
}

/** Does a command exist on PATH? */
export async function has(bin: string): Promise<boolean> {
  try {
    await shOk(`command -v ${bin}`, { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}
