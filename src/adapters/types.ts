/** File contents keyed by path relative to the project directory; null = absent. */
export type Snapshot = Record<string, string | null>;

/** One dependency change between base and head. The unit the bisection works on. */
export interface Update {
  /** Stable identifier, unique within one diff. */
  id: string;
  name: string;
  /** Manifest section, e.g. "dependencies" or "devDependencies". */
  section: string;
  /** Human-readable version before/after; null when added/removed. */
  from: string | null;
  to: string | null;
}

export interface Adapter {
  name: string;
  /** Files (relative to the project dir) this adapter reads and rewrites. */
  files: string[];
  detect(head: Snapshot): boolean;
  diff(base: Snapshot, head: Snapshot): Update[];
  /** Extra information for the report, e.g. changes the adapter cannot bisect. */
  notes(base: Snapshot, head: Snapshot): string[];
  /** Write the base dependency state with `subset` applied into `dir`. */
  write(dir: string, base: Snapshot, head: Snapshot, subset: Update[]): Promise<void>;
  installCommand: string;
}
