export interface PickState<T> {
  hits: readonly T[];
  active: number;
  open: boolean;
  /** The search text the hits were found for. */
  hitsFor: string;
  /** The text in the box now. */
  term: string;
}

/**
 * The hit Enter should add, if any. A scanner types fast and sends Enter at once, before the type-ahead
 * catches up: a hit highlighted for an older text (the mouse resting on the list) must not be added.
 */
export function pickableHit<T>(s: PickState<T>): T | undefined {
  if (!s.open || s.active < 0 || s.hitsFor !== s.term) return undefined;
  return s.hits[s.active];
}
