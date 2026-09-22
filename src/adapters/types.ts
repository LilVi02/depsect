/** File contents keyed by path relative to the project directory; null = absent. */
export type Snapshot = Record<string, string | null>;

/** One dependency change between base and head. The unit the bisection works on. */
export interface Update {
  /** Stable identifier, unique within one diff. */
  id: string;
  name: string;
  /** Where it is declared, e.g. "dependencies", "dev", or "lockfile" for transitive packages. */
  section: string;
  /** Human-readable version before/after; null when added/removed. */
  from: string | null;
  to: string | null;
  /** Direct dependencies are declared in the manifest; transitive ones only appear in the lockfile. */
  kind: 'direct' | 'transitive';
}

export interface Diff {
  updates: Update[];
  /** Changes the adapter saw but cannot apply on their own, as human-readable strings. */
  excluded: string[];
}

export interface Adapter {
  name: string;
  /** Files (relative to the project dir) this adapter reads and rewrites. */
  files: string[];
  detect(head: Snapshot): boolean;
  diff(base: Snapshot, head: Snapshot): Diff;
  /**
   * Write the base dependency state with `subset` applied into `dir`. Returns
   * shell commands to run afterwards (in `dir`, in order) to finish applying
   * it, e.g. `cargo update --precise`. The install command runs after those.
   */
  write(dir: string, base: Snapshot, head: Snapshot, subset: Update[]): Promise<string[]>;
  /**
   * Optional: after the safe set is installed, turn the working files into
   * what a human would commit (e.g. drop temporary version pins). Returns
   * commands to run; the install command runs again afterwards.
   */
  finalize?(dir: string, base: Snapshot, head: Snapshot, subset: Update[]): Promise<string[]>;
  installCommand(head: Snapshot): string;
  /** Environment for every command depsect runs for this project, including the test command. */
  env?: Record<string, string>;
}

/** Group versions for display: "1.0.0" or "1.0.0, 2.0.0"; null when there are none. */
export const showVersions = (vs: Iterable<string> | undefined): string | null => {
  const list = [...(vs ?? [])].sort();
  return list.length ? list.join(', ') : null;
};

/** True when two version sets hold the same versions. */
export const sameSet = (a?: Set<string>, b?: Set<string>) =>
  (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every((v) => b?.has(v));
