/**
 * Fallback single-tab lock for browsers without `navigator.locks` (an http:// page that is not localhost, for one).
 * Two tabs on the same IndexedDB blob would overwrite each other's sales (QA S15), so the first tab takes a lease in
 * localStorage and renews it; another tab sees a live lease and stays out. A tab that dies stops renewing, and its
 * lease expires after LEASE_TTL_MS. The TTL is long because browsers slow timers in a hidden tab to about one a
 * minute; the lease is also renewed whenever the tab becomes visible again.
 */
export const LEASE_KEY = 'pos-db-owner-lease';
export const LEASE_RENEW_MS = 5_000;
export const LEASE_TTL_MS = 120_000;

interface Lease {
  owner: string;
  until: number;
}

export interface LeaseEnv {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  /** Runs `fn` when the tab becomes visible or focused again (timers may have been held back while hidden). */
  onWake: (fn: () => void) => void;
  /** Runs `fn` when the page is really going away (not when it only enters the back/forward cache). */
  onUnload: (fn: () => void) => void;
  newId: () => string;
}

function readLease(storage: LeaseEnv['storage']): Lease | null {
  try {
    const raw = storage.getItem(LEASE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<Lease>;
    return typeof v.owner === 'string' && typeof v.until === 'number'
      ? { owner: v.owner, until: v.until }
      : null;
  } catch {
    return null;
  }
}

/** True when this tab now owns the database (and keeps renewing the lease until the tab closes). */
export function acquireLease(env: LeaseEnv): boolean {
  const now = env.now();
  const current = readLease(env.storage);
  // a lease further ahead than one TTL was not written by a live tab (a damaged or planted value): ignore it
  const live =
    current !== null &&
    Number.isFinite(current.until) &&
    current.until > now &&
    current.until <= now + LEASE_TTL_MS;
  if (live) return false;

  const owner = env.newId();
  const write = (): void => {
    env.storage.setItem(LEASE_KEY, JSON.stringify({ owner, until: env.now() + LEASE_TTL_MS }));
  };
  try {
    write();
    // two tabs opened in the same instant both saw no lease: the read-back narrows that race (it is not atomic)
    if (readLease(env.storage)?.owner !== owner) return false;
  } catch {
    return true; // storage blocked (private mode): nothing to coordinate with, behave as before
  }
  const renew = (): void => {
    try {
      if (readLease(env.storage)?.owner === owner) write();
    } catch {
      /* storage went away; the lease simply expires */
    }
  };
  env.setInterval(renew, LEASE_RENEW_MS);
  env.onWake(renew);
  env.onUnload(() => {
    try {
      if (readLease(env.storage)?.owner === owner) env.storage.removeItem(LEASE_KEY);
    } catch {
      /* nothing to release */
    }
  });
  return true;
}
