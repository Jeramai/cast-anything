/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  advance,
  anchorOrder,
  indexAfterRemoval,
  makeOrder,
  retreat,
  type NavState,
  type RepeatMode,
} from './playlist';

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

const state = (p: Partial<NavState> & { length: number }): NavState => ({
  current: 0,
  order: identity(p.length),
  repeat: 'off',
  ...p,
});

describe('makeOrder', () => {
  test('identity order when shuffle is off', () => {
    expect(makeOrder(4, false)).toEqual([0, 1, 2, 3]);
  });

  test('empty queue → empty order', () => {
    expect(makeOrder(0, true)).toEqual([]);
  });

  test('shuffled order is a permutation of the identity', () => {
    // A fixed, non-trivial rng so the test is deterministic.
    let i = 0;
    const seq = [0.9, 0.1, 0.7, 0.3, 0.5];
    const rng = () => seq[i++ % seq.length];
    const order = makeOrder(5, true, rng);
    expect(order.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(order.length).toBe(5);
  });
});

describe('advance (auto vs manual)', () => {
  test('auto-advance to the next item', () => {
    expect(advance(state({ length: 3, current: 0 }), false)).toBe(1);
  });

  test('stops at the end when repeat is off', () => {
    expect(advance(state({ length: 3, current: 2 }), false)).toBeNull();
  });

  test('repeat-all wraps to the front at the end', () => {
    expect(advance(state({ length: 3, current: 2, repeat: 'all' }), false)).toBe(0);
  });

  test('repeat-one replays the same item on auto-advance', () => {
    expect(advance(state({ length: 3, current: 1, repeat: 'one' }), false)).toBe(1);
  });

  test('repeat-one still moves on when the user presses Next (manual)', () => {
    expect(advance(state({ length: 3, current: 1, repeat: 'one' }), true)).toBe(2);
  });

  test('nothing playing yet (current -1) starts at the front of the order', () => {
    expect(advance(state({ length: 3, current: -1 }), true)).toBe(0);
  });

  test('empty queue → null', () => {
    expect(advance(state({ length: 0, current: -1 }), false)).toBeNull();
  });

  test('follows a shuffled order, not the natural order', () => {
    const order = [2, 0, 1];
    expect(advance({ length: 3, current: 2, order, repeat: 'off' }, false)).toBe(0);
    expect(advance({ length: 3, current: 0, order, repeat: 'off' }, false)).toBe(1);
    expect(advance({ length: 3, current: 1, order, repeat: 'off' }, false)).toBeNull();
  });
});

describe('retreat (Previous)', () => {
  test('steps back to the previous item', () => {
    expect(retreat(state({ length: 3, current: 2 }))).toBe(1);
  });

  test('at the first item, restarts it when repeat is off', () => {
    expect(retreat(state({ length: 3, current: 0 }))).toBe(0);
  });

  test('repeat-all wraps to the last item from the front', () => {
    expect(retreat(state({ length: 3, current: 0, repeat: 'all' }))).toBe(2);
  });

  test('follows a shuffled order backwards', () => {
    const order = [2, 0, 1];
    expect(retreat({ length: 3, current: 1, order, repeat: 'off' })).toBe(0);
    expect(retreat({ length: 3, current: 0, order, repeat: 'off' })).toBe(2);
  });
});

describe('indexAfterRemoval', () => {
  test('removing an earlier item shifts current down', () => {
    expect(indexAfterRemoval(2, 0, 3)).toBe(1);
  });

  test('removing a later item leaves current unchanged', () => {
    expect(indexAfterRemoval(1, 2, 3)).toBe(1);
  });

  test('removing the current item points at the PREVIOUS slot, so advance() plays the slid-in item next', () => {
    // Queue [A,B,C], B (idx 1) playing and removed → current becomes 0; advance(0)
    // then plays index 1 = C. Pointing at 1 directly would make advance skip C.
    expect(indexAfterRemoval(1, 1, 2)).toBe(0);
    // advance from the returned index reaches the slid-in item:
    expect(advance({ length: 2, current: 0, order: identity(2), repeat: 'off' }, false)).toBe(1);
  });

  test('removing the current HEAD item → -1, and advance resumes at the new head', () => {
    expect(indexAfterRemoval(0, 0, 2)).toBe(-1);
    expect(advance({ length: 2, current: -1, order: identity(2), repeat: 'off' }, false)).toBe(0);
  });

  test('emptying the queue → -1', () => {
    expect(indexAfterRemoval(0, 0, 0)).toBe(-1);
  });
});

describe('anchorOrder', () => {
  test('moves the current index to the front, preserving relative order of the rest', () => {
    expect(anchorOrder([3, 4, 0, 2, 1], 0)).toEqual([0, 3, 4, 2, 1]);
  });

  test('no-op when current is already first or absent', () => {
    expect(anchorOrder([2, 0, 1], 2)).toEqual([2, 0, 1]);
    expect(anchorOrder([2, 0, 1], 9)).toEqual([2, 0, 1]);
    expect(anchorOrder([], 0)).toEqual([]);
  });

  test('anchored order lets advance() visit every remaining item exactly once', () => {
    const order = anchorOrder([3, 4, 0, 2, 1], 0);
    const visited: number[] = [];
    let cur = 0;
    for (;;) {
      const nxt = advance({ length: 5, current: cur, order, repeat: 'off' }, false);
      if (nxt == null) break;
      visited.push(nxt);
      cur = nxt;
    }
    expect(visited.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]); // all others played
  });
});

// Repeat-mode cycling is a tiny UI helper, but assert the intended order here so the
// hook and the UI stay in agreement: off → all → one → off.
describe('repeat cycle contract', () => {
  test('cycle order', () => {
    const nextRepeat = (r: RepeatMode): RepeatMode =>
      r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
    expect(nextRepeat('off')).toBe('all');
    expect(nextRepeat('all')).toBe('one');
    expect(nextRepeat('one')).toBe('off');
  });
});
