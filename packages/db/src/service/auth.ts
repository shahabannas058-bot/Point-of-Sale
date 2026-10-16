import {
  RoleSchema,
  ServiceError,
  hasPermission,
  type ApprovalGrant,
  type AuthApi,
  type Permission,
  type Role,
  type Session,
  type User,
} from '@pos/shared';
import { WriteBatch } from './batch';
import {
  APPROVAL_TTL_MS,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILS,
  requirePermission,
  requireSession,
  type Ctx,
} from './deps';
import { guardApi, invalid, reqText } from './errors';
import { mapRow, mapRows, type Raw } from './mappers';
import { hashPin, validatePinFormat, verifyPin } from './pin';
import { USER_COLS, insertUser, updateUserPin, type UserRec } from './queries';

const bytesHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------- approvals (single use, 60 s, in memory) ----------
/** Returns the approver's username when `token` is a live grant, else null. Unknown/expired/used tokens are simply "no token". */
export function lookupApproval(ctx: Ctx, token: string | undefined): string | null {
  if (token === undefined) return null;
  const grant = ctx.approvals.get(token);
  if (grant === undefined) return null;
  if (grant.expiresAt <= ctx.clock()) {
    ctx.approvals.delete(token);
    return null;
  }
  return grant.approverUsername;
}

export function consumeApproval(ctx: Ctx, token: string | undefined): void {
  if (token !== undefined) ctx.approvals.delete(token);
}

// ---------- throttling (in memory only) ----------
function assertNotLocked(ctx: Ctx, key: string): void {
  const t = ctx.throttles.get(key);
  const now = ctx.clock();
  if (t !== undefined && t.lockedUntil > now)
    throw new ServiceError('LOGIN_LOCKED', 'Too many failed attempts. Try again shortly.', {
      retryAfterMs: t.lockedUntil - now,
    });
}

function recordFailure(ctx: Ctx, key: string): void {
  const now = ctx.clock();
  const t = ctx.throttles.get(key) ?? { fails: 0, lockedUntil: 0 };
  // a lock that already expired starts a fresh window
  const fails = t.lockedUntil > 0 && t.lockedUntil <= now ? 1 : t.fails + 1;
  ctx.throttles.set(
    key,
    fails >= LOGIN_MAX_FAILS
      ? { fails: 0, lockedUntil: now + LOGIN_LOCK_MS }
      : { fails, lockedUntil: 0 },
  );
}

const loginKey = (username: string): string => `login:${username}`;

interface UserAuthRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  pin_hash: string;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export function createAuthApi(ctx: Ctx): AuthApi {
  const publicRow = (r: UserAuthRow): Raw => {
    const { pin_hash: _pinHash, ...rest } = r;
    return rest;
  };
  const toUser = (r: UserAuthRow): User => mapRow<User>(publicRow(r));
  const toRec = (r: UserAuthRow): UserRec => mapRow<UserRec>(publicRow(r));

  return guardApi<AuthApi>({
    async listLoginUsers() {
      const rows = await ctx.driver.query<Raw>(
        `SELECT username, display_name, role FROM users WHERE is_active = 1
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, username`,
      );
      return mapRows<Pick<User, 'username' | 'displayName' | 'role'>>(rows);
    },

    async login(username, pin) {
      const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
      const key = loginKey(name);
      assertNotLocked(ctx, key);
      const rows = await ctx.driver.query<UserAuthRow>(
        'SELECT * FROM users WHERE username = ? AND is_active = 1',
        [name],
      );
      const row = rows[0];
      let ok = false;
      if (typeof pin === 'string' && /^\d{1,12}$/.test(pin)) {
        if (row !== undefined) ok = await verifyPin(pin, row.pin_hash);
        else await hashPin(pin, ctx.pinIterations, ctx.randomBytes); // keep timing similar for unknown users
      }
      if (!ok || row === undefined) {
        recordFailure(ctx, key);
        throw new ServiceError('INVALID_CREDENTIALS', 'Wrong username or PIN');
      }
      ctx.throttles.delete(key);
      const session: Session = {
        user: toUser(row),
        startedAt: ctx.clock(),
      };
      ctx.session = session;
      ctx.approvals.clear();
      return session;
    },

    logout() {
      ctx.session = null;
      ctx.approvals.clear();
    },

    current() {
      return ctx.session;
    },

    can(p: Permission) {
      return ctx.session !== null && hasPermission(ctx.session.user.role, p);
    },

    async requestApproval(pin): Promise<ApprovalGrant> {
      const session = requireSession(ctx);
      const key = `approval:${session.user.id}`;
      assertNotLocked(ctx, key);
      const approvers = await ctx.driver.query<UserAuthRow>(
        "SELECT * FROM users WHERE is_active = 1 AND role IN ('owner', 'manager')",
      );
      let approver: UserAuthRow | undefined;
      if (typeof pin === 'string' && /^\d{1,12}$/.test(pin))
        for (const u of approvers)
          if (await verifyPin(pin, u.pin_hash)) {
            approver = u;
            break;
          }
      if (approver === undefined) {
        recordFailure(ctx, key);
        throw new ServiceError('APPROVAL_INVALID', 'Wrong manager PIN');
      }
      ctx.throttles.delete(key);
      const token = bytesHex(ctx.randomBytes(16));
      const expiresAt = ctx.clock() + APPROVAL_TTL_MS;
      ctx.approvals.set(token, { approverUsername: approver.username, expiresAt });
      return { token, approverUsername: approver.username, expiresAt };
    },

    async changePin(oldPin, newPin) {
      const session = requireSession(ctx);
      validatePinFormat(newPin, 'newPin');
      const rows = await ctx.driver.query<UserAuthRow>('SELECT * FROM users WHERE id = ?', [
        session.user.id,
      ]);
      const row = rows[0];
      if (
        row === undefined ||
        typeof oldPin !== 'string' ||
        !(await verifyPin(oldPin, row.pin_hash))
      )
        throw new ServiceError('INVALID_CREDENTIALS', 'Current PIN is wrong');
      const pinHash = await hashPin(newPin, ctx.pinIterations, ctx.randomBytes);
      await ctx.lock(async () => {
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        updateUserPin(b, toRec(row), pinHash, at);
        await b.commit(ctx.driver);
      });
    },

    async listUsers() {
      requirePermission(ctx, 'manage_users');
      const rows = await ctx.driver.query<Raw>(
        `SELECT ${USER_COLS} FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, username`,
      );
      return mapRows<User>(rows);
    },

    async createUser(i) {
      requirePermission(ctx, 'manage_users');
      const username = reqText(i.username, 'username', 3, 32).toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(username))
        throw invalid('username', 'Username may contain only a-z, 0-9, dot, dash, underscore');
      const displayName = reqText(i.displayName, 'displayName', 1, 100);
      const role = RoleSchema.safeParse(i.role);
      if (!role.success) throw invalid('role', 'Unknown role');
      validatePinFormat(i.pin);
      const pinHash = await hashPin(i.pin, ctx.pinIterations, ctx.randomBytes);
      return ctx.lock(async () => {
        const at = ctx.clock();
        const rec: UserRec = {
          id: ctx.newId(),
          username,
          displayName,
          role: role.data,
          isActive: true,
          createdAt: at,
          updatedAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertUser(b, rec, pinHash);
        await b.commit(ctx.driver);
        return rec as unknown as User;
      });
    },
  });
}
