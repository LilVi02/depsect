// A small TOML reader (enough for pyproject.toml, Cargo.toml and lockfiles)
// plus helpers to locate and splice entries in the original text, so edits
// never reformat the user's files.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

class Parser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  error(msg: string): never {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`TOML parse error on line ${line}: ${msg}`);
  }

  peek(n = 0) {
    return this.s[this.i + n] ?? '';
  }

  /** Skip spaces/tabs, and also newlines and comments when `newlines` is set. */
  ws(newlines = false) {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (newlines && c === '\n') this.i++;
      else if (c === '#') while (this.i < this.s.length && this.peek() !== '\n') this.i++;
      else return;
    }
  }

  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === '"' || c === "'") parts.push(this.string());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) this.error('expected a key');
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.ws();
      if (this.peek() !== '.') return parts;
      this.i++;
    }
  }

  string(): string {
    const q = this.peek();
    const multi = this.s.startsWith(q.repeat(3), this.i);
    this.i += multi ? 3 : 1;
    if (multi && this.peek() === '\n') this.i++;
    else if (multi && this.s.startsWith('\r\n', this.i)) this.i += 2;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.error('unterminated string');
      if (multi ? this.s.startsWith(q.repeat(3), this.i) : this.peek() === q) {
        // Up to two quotes may sit right before the closing delimiter.
        if (multi) while (this.s.startsWith(q.repeat(4), this.i)) (out += q), this.i++;
        this.i += multi ? 3 : 1;
        return out;
      }
      const c = this.s[this.i++]!;
      if (c === '\n' && !multi) this.error('newline in string');
      if (c !== '\\' || q === "'") {
        out += c;
        continue;
      }
      const e = this.s[this.i++]!;
      const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (e in simple) out += simple[e];
      else if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8;
        out += String.fromCodePoint(parseInt(this.s.slice(this.i, this.i + len), 16));
        this.i += len;
      } else if (multi && /\s/.test(e)) {
        // Line-ending backslash: trim whitespace up to the next content.
        while (/\s/.test(this.peek())) this.i++;
      } else this.error(`bad escape \\${e}`);
    }
  }

  value(): TomlValue {
    this.ws();
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '[') {
      this.i++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (this.peek() === ']') return this.i++, arr;
        arr.push(this.value());
        this.ws(true);
        if (this.peek() === ',') this.i++;
        else if (this.peek() !== ']') this.error('expected , or ] in array');
      }
    }
    if (c === '{') {
      this.i++;
      const table: TomlTable = {};
      this.ws();
      if (this.peek() === '}') return this.i++, table;
      for (;;) {
        const k = this.key();
        if (this.peek() !== '=') this.error('expected = in inline table');
        this.i++;
        setPath(table, k, this.value());
        this.ws();
        if (this.peek() === ',') (this.i++, this.ws());
        else if (this.peek() === '}') return this.i++, table;
        else this.error('expected , or } in inline table');
      }
    }
    // Scalars: booleans, numbers, dates. Dates stay strings.
    const m = /^[^\s,\]}#]+(?: [0-9:.+\-Z]+)?/.exec(this.s.slice(this.i));
    if (!m) this.error('expected a value');
    this.i += m[0].length;
    const raw = m[0];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = raw.replace(/_/g, '');
    if (/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|inf|nan)$/.test(num)) return Number(num);
    return raw;
  }
}

function setPath(table: TomlTable, path: string[], value: TomlValue) {
  let t = table;
  for (const k of path.slice(0, -1)) {
    if (typeof t[k] !== 'object' || Array.isArray(t[k])) t[k] = {};
    t = t[k] as TomlTable;
  }
  t[path[path.length - 1]!] = value;
}

export function parseToml(text: string): TomlTable {
  const p = new Parser(text);
  const root: TomlTable = {};
  let current = root;
  for (;;) {
    p.ws(true);
    if (p.i >= text.length) return root;
    if (p.peek() === '[') {
      const isArray = p.peek(1) === '[';
      p.i += isArray ? 2 : 1;
      const path = p.key();
      p.i += isArray ? 2 : 1;
      let t: TomlTable = root;
      path.forEach((k, idx) => {
        const last = idx === path.length - 1;
        if (last && isArray) {
          if (!Array.isArray(t[k])) t[k] = [];
          const arr = t[k] as TomlTable[];
          arr.push({});
          t = arr[arr.length - 1]!;
          return;
        }
        let next = t[k];
        if (Array.isArray(next)) next = next[next.length - 1]; // [[a]] then [a.b]
        if (typeof next !== 'object' || next === null) t[k] = next = {};
        t = next as TomlTable;
      });
      current = t;
      continue;
    }
    const key = p.key();
    if (p.peek() !== '=') p.error('expected =');
    p.i++;
    setPath(current, key, p.value());
  }
}

// --- Text-level helpers -------------------------------------------------------

/** The dotted path of a `[table]` header line, or null if the line is not a header. */
export function headerPath(line: string): string[] | null {
  const m = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return null;
  try {
    return new Parser(m[1]!).key();
  } catch {
    return null;
  }
}

export interface Span {
  start: number;
  end: number;
}

/** Character offsets of each line start. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** End offset (exclusive, including the newline) of a key/value entry starting at `from`. */
function entryEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? text.indexOf(c.repeat(3), i + 3) : text.indexOf(c, i + 1);
      if (!triple && c === '"') {
        // Skip escaped quotes in basic strings.
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      i = (close < 0 ? text.length : close) + (triple ? 3 : 1);
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) return i + 1;
    i++;
  }
  return text.length;
}

const samePath = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** Span of the whole `[table]` section (header through the line before the next header). */
export function findTable(text: string, table: string[]): Span | null {
  const starts = lineStarts(text);
  for (let li = 0; li < starts.length; li++) {
    const line = text.slice(starts[li], (starts[li + 1] ?? text.length + 1) - 1);
    if (!samePath(headerPath(line), table)) continue;
    let lj = li + 1;
    while (lj < starts.length && headerPath(text.slice(starts[lj], (starts[lj + 1] ?? text.length + 1) - 1)) === null) lj++;
    return { start: starts[li]!, end: starts[lj] ?? text.length };
  }
  return null;
}

/** Span of `key = value` (possibly multi-line) directly inside `[table]`. */
export function findEntry(text: string, table: string[], key: string): Span | null {
  const t = findTable(text, table);
  if (!t) return null;
  const body = text.slice(t.start, t.end);
  const starts = lineStarts(body);
  for (const s of starts.slice(1)) {
    const rest = body.slice(s);
    const m = /^[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)[ \t]*=/.exec(rest);
    if (!m) continue;
    const k = m[1]!.replace(/^["'](.*)["']$/, '$1');
    if (k !== key) continue;
    return { start: t.start + s, end: t.start + entryEnd(body, s + m[0].length) };
  }
  return null;
}

export const splice = (text: string, span: Span, replacement: string) =>
  text.slice(0, span.start) + replacement + text.slice(span.end);
