/** Group versions for display: "1.0.0" or "1.0.0, 2.0.0"; null when there are none. */
export const showVersions = (vs) => {
    const list = [...(vs ?? [])].sort();
    return list.length ? list.join(', ') : null;
};
/** True when two version sets hold the same versions. */
export const sameSet = (a, b) => (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every((v) => b?.has(v));
