import type { SqlJsStatic } from 'sql.js';
import { createPosService } from '@pos/db/service';
import { ServiceError } from '@pos/shared';
import { createSqlJsDriver } from './sqljs-driver';

/**
 * The boot screen for a database that migration 0009 refused is shown before anyone signs in, and its actions hand
 * out or replace the whole database. They wait for the owner PIN, and "start fresh" also waits for a copy downloaded
 * in this session, so the old data cannot be wiped without a copy. A database with no active owner can never be
 * unlocked by a PIN, so there download and restore are offered without one (reset still waits for a copy).
 */
export interface LegacyGate {
  unlocked: boolean;
  downloaded: boolean;
  ownerless: boolean;
}

export const legacyActions = (
  g: LegacyGate,
): { download: boolean; restore: boolean; reset: boolean } => {
  const open = g.unlocked || g.ownerless;
  return { download: open, restore: open, reset: open && g.downloaded };
};

export interface OwnerPinCheck {
  /** False when the stored database has no active owner, so no PIN can unlock it. */
  hasOwner(): Promise<boolean>;
  /** Resolves when the PIN is an owner's; rejects with INVALID_CREDENTIALS or LOGIN_LOCKED otherwise. */
  verify(pin: string): Promise<void>;
}

/**
 * Checks a PIN against the active owners of the stored (refused, so unmigrated) database bytes. It reads a separate
 * in-memory copy that is never migrated or saved, and signs in through the service's own login, so the PIN hash
 * check and the wrong-PIN lockout are the login screen's. Keep one checker per screen so the lockout holds.
 */
export function createOwnerPinCheck(SQL: SqlJsStatic, bytes: Uint8Array): OwnerPinCheck {
  const driver = createSqlJsDriver(new SQL.Database(bytes));
  const ready = driver.exec('PRAGMA query_only = ON');
  const { auth } = createPosService({ driver });
  const owners = async (): Promise<{ username: string }[]> => {
    await ready;
    return driver.query<{ username: string }>(
      "SELECT username FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at",
    );
  };
  return {
    hasOwner: async () => (await owners()).length > 0,
    async verify(pin) {
      let failure: unknown = new ServiceError('INVALID_CREDENTIALS', 'Wrong username or PIN');
      for (const { username } of await owners()) {
        try {
          await auth.login(username, pin);
          auth.logout();
          return;
        } catch (e: unknown) {
          failure = e;
        }
      }
      throw failure;
    },
  };
}
