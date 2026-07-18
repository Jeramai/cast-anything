// Pure playlist navigation — no React or native imports, so it's unit-testable.
// useCast holds the actual queue of MediaItems and calls these to decide what plays
// next when a track ends (auto-advance) or the user hits Next / Previous.
//
// The play *order* is kept as a separate permutation of [0..n-1]: identity for
// normal playback, or a shuffled permutation when shuffle is on. Navigation always
// locates the current queue index *within* that order and steps through it, so the
// same functions serve both modes and shuffle survives across advances.

export type RepeatMode = 'off' | 'all' | 'one';

/** In-order sequence of a repeating call `rng` — defaults to Math.random. */
export type Rng = () => number;

/**
 * Build the play order: the identity `[0,1,…,length-1]` normally, or a Fisher-Yates
 * shuffle of it when `shuffle` is true. Always a full permutation, so navigation can
 * find any current index inside it. `rng` is injectable for deterministic tests.
 */
export function makeOrder(length: number, shuffle: boolean, rng: Rng = Math.random): number[] {
  const order = Array.from({ length }, (_, i) => i);
  if (!shuffle) return order;
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

export interface NavState {
  /** Number of items in the queue. */
  length: number;
  /** The queue index currently playing (-1 if nothing has played yet). */
  current: number;
  /** The play order (a permutation of [0..length-1]); see {@link makeOrder}. */
  order: number[];
  repeat: RepeatMode;
}

/** Position of `current` within `order`, or -1 if not present. */
function orderPos(order: number[], current: number): number {
  return order.indexOf(current);
}

/**
 * The queue index to play next, or null if playback should stop.
 *
 * `manual` distinguishes an auto-advance (a track ended) from the user pressing
 * Next: repeat-one replays the same track on auto-advance, but Next still moves on.
 * At the end of the order we wrap only when repeat is 'all'; otherwise we stop (null).
 */
export function advance(state: NavState, manual: boolean): number | null {
  const { length, current, order, repeat } = state;
  if (length === 0) return null;
  if (repeat === 'one' && !manual) return current >= 0 ? current : (order[0] ?? null);
  const pos = orderPos(order, current);
  // Nothing playing yet (or current fell out of the order) → start at the front.
  if (pos < 0) return order[0] ?? null;
  if (pos + 1 < order.length) return order[pos + 1];
  return repeat === 'all' ? (order[0] ?? null) : null;
}

/**
 * The queue index to play when the user presses Previous. Steps back through the
 * order, wrapping to the end only when repeat is 'all'; at the very start (no wrap)
 * it restarts the current item rather than stopping.
 */
export function retreat(state: NavState): number | null {
  const { length, current, order, repeat } = state;
  if (length === 0) return null;
  const pos = orderPos(order, current);
  if (pos < 0) return order[0] ?? null;
  if (pos - 1 >= 0) return order[pos - 1];
  return repeat === 'all' ? (order[order.length - 1] ?? null) : order[0] ?? null;
}

/**
 * Reconcile the current index after an item is removed from the queue at
 * `removedIndex`. Returns the index that keeps the *same item* current where
 * possible (shifts down when an earlier item was removed). When the current item
 * itself is removed it returns the slot BEFORE it (possibly -1): the removed track
 * keeps playing on the TV but is no longer in the queue, and pointing "current" at
 * the previous slot means auto-advance resumes with the item that slid into the
 * removed slot — pointing at that item directly would make advance() skip it.
 */
export function indexAfterRemoval(current: number, removedIndex: number, newLength: number): number {
  if (newLength <= 0) return -1;
  if (removedIndex < current) return current - 1;
  if (removedIndex > current) return current;
  return removedIndex - 1;
}

/**
 * Move `current` to the FRONT of a (shuffled) play order. Used when the order is
 * rebuilt while something is playing: advance() only walks forward from the current
 * position, so an unanchored fresh permutation would silently skip every item that
 * happened to land before the current one (~half the queue on average).
 */
export function anchorOrder(order: number[], current: number): number[] {
  const pos = order.indexOf(current);
  if (pos <= 0) return order;
  const next = order.slice();
  next.splice(pos, 1);
  next.unshift(current);
  return next;
}
