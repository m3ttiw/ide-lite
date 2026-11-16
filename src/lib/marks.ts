// Multi-selection in a keyboard list: Ctrl+arrows select like Shift+arrows in a
// file manager, a toggle key adds or drops a single row.

export interface Marks {
  /** Keys of the selected rows. */
  readonly keys: ReadonlySet<string>;
  /**
   * The Ctrl+arrow run in progress: the selection before it, the row it started
   * on and the row it reached. Moving back over the run shrinks it.
   */
  readonly run: { readonly base: ReadonlySet<string>; readonly anchor: number; readonly end: number } | null;
}

export const NO_MARKS: Marks = { keys: new Set(), run: null };

/**
 * The cursor moved from row `from` to row `to` with Ctrl held. A run continues
 * when it starts where the last one ended; otherwise a new one starts at
 * `from`. Rows between the anchor and `to` are selected, except the ones
 * `markable` rejects.
 */
export function extendMarks(m: Marks, rows: readonly string[], markable: (i: number) => boolean, from: number, to: number): Marks {
  const run = m.run && m.run.end === from ? m.run : { base: m.keys, anchor: from, end: from };
  const keys = new Set(run.base);
  const lo = Math.max(0, Math.min(run.anchor, to));
  const hi = Math.min(rows.length - 1, Math.max(run.anchor, to));
  for (let i = lo; i <= hi; i++) if (markable(i)) keys.add(rows[i]);
  return { keys, run: { base: run.base, anchor: run.anchor, end: to } };
}

/** Adds or drops one row; ends any Ctrl+arrow run. */
export function toggleMark(m: Marks, key: string): Marks {
  const keys = new Set(m.keys);
  if (!keys.delete(key)) keys.add(key);
  return { keys, run: null };
}

/** Keeps only the selected keys that are still listed (after a reload). */
export function keepListed(m: Marks, listed: readonly string[]): Marks {
  const all = new Set(listed);
  const keys = new Set([...m.keys].filter((k) => all.has(k)));
  return keys.size === m.keys.size ? m : { keys, run: null };
}
