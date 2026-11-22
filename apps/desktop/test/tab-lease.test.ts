import { describe, expect, it } from 'vitest';
import {
  acquireLease,
  LEASE_KEY,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  type LeaseEnv,
} from '../src/db/tab-lease';

/** Two tabs share one localStorage and one clock; timers run when the test moves the clock. */
function world() {
  const store = new Map<string, string>();
  let now = 1_000_000;
  let nextId = 0;
  const timers: { fn: () => void; ms: number; last: number; alive: () => boolean }[] = [];
  const storage: LeaseEnv['storage'] = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const tab = () => {
    let open = true;
    const unload: (() => void)[] = [];
    const env: LeaseEnv = {
      storage,
      now: () => now,
      setInterval: (fn, ms) => timers.push({ fn, ms, last: now, alive: () => open }),
      onWake: () => undefined,
      onUnload: (fn) => unload.push(fn),
      newId: () => `tab-${(nextId += 1)}`,
    };
    return {
      acquire: () => acquireLease(env),
      close: () => unload.forEach((fn) => fn()),
      crash: () => {
        open = false; // no unload event, timers stop
      },
    };
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 500);
      for (const t of timers)
        if (t.alive() && now - t.last >= t.ms) {
          t.last = now;
          t.fn();
        }
    }
  };
  return { tab, advance, store };
}

describe('tab lease without navigator.locks (QA S15)', () => {
  it('a second tab is kept out while the first one is open, even long after', () => {
    const w = world();
    expect(w.tab().acquire()).toBe(true);
    w.advance(LEASE_TTL_MS * 5);
    expect(w.tab().acquire()).toBe(false);
  });

  it('a closed tab hands the database over at once', () => {
    const w = world();
    const first = w.tab();
    expect(first.acquire()).toBe(true);
    first.close();
    expect(w.store.has(LEASE_KEY)).toBe(false);
    expect(w.tab().acquire()).toBe(true);
  });

  it('a crashed tab stops renewing and its lease expires', () => {
    const w = world();
    const first = w.tab();
    expect(first.acquire()).toBe(true);
    first.crash();
    w.advance(LEASE_RENEW_MS);
    expect(w.tab().acquire()).toBe(false);
    w.advance(LEASE_TTL_MS);
    expect(w.tab().acquire()).toBe(true);
  });

  it('a damaged lease value does not lock the shop out', () => {
    const w = world();
    w.store.set(LEASE_KEY, '{not json');
    expect(w.tab().acquire()).toBe(true);
  });

  it('a lease dated far in the future (planted or corrupt) does not lock the shop out', () => {
    const w = world();
    w.store.set(LEASE_KEY, JSON.stringify({ owner: 'x', until: 1e300 }));
    expect(w.tab().acquire()).toBe(true);
  });
});
