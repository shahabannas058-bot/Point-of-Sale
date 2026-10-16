import { createUuidV7Generator } from '@pos/core';
import {
  ServiceError,
  hasPermission,
  type AssertCanSell,
  type Permission,
  type Session,
} from '@pos/shared';
import type { SqlDriver } from '../types';
import { createMutex, type Mutex } from './mutex';

export interface ServiceDeps {
  driver: SqlDriver;
  /** Licence hook; called inside the write lock right before the batch. Default: allow everything. */
  assertCanSell?: AssertCanSell;
  clock?: () => number;
  newId?: () => string;
  randomBytes?: (n: number) => Uint8Array;
  /** PBKDF2 iterations for NEW pin hashes (stored hashes carry their own). Default 30 000; tests use 1 000. */
  pinIterations?: number;
}

export const DEFAULT_PIN_ITERATIONS = 30_000;
export const APPROVAL_TTL_MS = 60_000;
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 30_000;

export interface PendingApproval {
  approverUsername: string;
  expiresAt: number;
}
export interface Throttle {
  fails: number;
  lockedUntil: number;
}

/** Internal per-service state shared by all API modules. Not part of the public contract. */
export interface Ctx {
  readonly driver: SqlDriver;
  readonly assertCanSell: AssertCanSell;
  readonly clock: () => number;
  readonly newId: () => string;
  readonly randomBytes: (n: number) => Uint8Array;
  readonly pinIterations: number;
  readonly lock: Mutex;
  session: Session | null;
  readonly approvals: Map<string, PendingApproval>;
  readonly throttles: Map<string, Throttle>;
}

/** The hook is app code, not the database: a plain Error from it keeps its message (as INTERNAL) so the lock screen can log why. */
function wrapGuard(hook: AssertCanSell): AssertCanSell {
  return async (c) => {
    try {
      await hook(c);
    } catch (e) {
      if (e instanceof Error && !(e instanceof ServiceError))
        throw new ServiceError('INTERNAL', e.message);
      throw e;
    }
  };
}

export function createCtx(deps: ServiceDeps): Ctx {
  return {
    driver: deps.driver,
    assertCanSell: wrapGuard(deps.assertCanSell ?? (() => Promise.resolve())),
    clock: deps.clock ?? Date.now,
    newId: deps.newId ?? createUuidV7Generator(),
    randomBytes: deps.randomBytes ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n))),
    pinIterations: deps.pinIterations ?? DEFAULT_PIN_ITERATIONS,
    lock: createMutex(),
    session: null,
    approvals: new Map(),
    throttles: new Map(),
  };
}

export function requireSession(ctx: Ctx): Session {
  if (ctx.session === null) throw new ServiceError('NOT_AUTHENTICATED', 'Login required');
  return ctx.session;
}

export const canDo = (ctx: Ctx, p: Permission): boolean =>
  ctx.session !== null && hasPermission(ctx.session.user.role, p);

export function requirePermission(ctx: Ctx, p: Permission): Session {
  const session = requireSession(ctx);
  if (!hasPermission(session.user.role, p))
    throw new ServiceError('FORBIDDEN', `Permission required: ${p}`, { permission: p });
  return session;
}
