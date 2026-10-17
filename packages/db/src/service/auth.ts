import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  ROLES,
  type ApprovalGrant,
  type LoginUser,
  type PosService,
  type Role,
  type Session,
  type ShopInfo,
  type ShopSettings,
  type User,
} from '@pos/shared';
import type { SqlValue, Statement } from '../driver';
import {
  can,
  emit,
  insert,
  one,
  q,
  readMeta,
  requirePerm,
  requireSession,
  write,
  type Ctx,
} from './context';
import { fail, intIn, invalid, optText, text } from './errors';

// ---------------- PIN hashing ----------------

const PIN_ITERATIONS = 10_000;
const PIN = /^\d{4,6}$/;
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const PREFIX = /^[A-Z0-9]{1,4}$/;
const LOCK_AFTER = 5;
const LOCK_MS = 30_000;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const dk = pbkdf2(sha256, utf8ToBytes(pin), salt, { c: PIN_ITERATIONS, dkLen: 32 });
  return `pbkdf2-sha256$${String(PIN_ITERATIONS)}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [alg, iter, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const dk = bytesToHex(
    pbkdf2(sha256, utf8ToBytes(pin), hexToBytes(salt), { c: Number(iter), dkLen: 32 }),
  );
  let diff = dk.length ^ hash.length;
  for (let i = 0; i < Math.min(dk.length, hash.length); i++)
    diff |= dk.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

const checkPin = (pin: unknown, field = 'pin'): string => {
  if (typeof pin !== 'string' || !PIN.test(pin)) return invalid(field, 'PIN must be 4 to 6 digits');
  return pin;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  pin_hash: string;
  is_active: number;
  created_at: number;
  updated_at: number;
};

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  isActive: r.is_active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ---------------- settings in app_meta ----------------

const SETTINGS_KEYS: Record<keyof ShopSettings, string> = {
  shopName: 'shop_name',
  address: 'address',
  phone: 'phone',
  receiptFooter: 'receipt_footer',
  receiptFooterUr: 'receipt_footer_ur',
  cashierMaxDiscountBps: 'cashier_max_discount_bps',
  allowNegativeStock: 'allow_negative_stock',
};

function settingsFrom(meta: Record<string, string>): ShopSettings {
  const bps = Number.parseInt(meta.cashier_max_discount_bps ?? '', 10);
  const opt = (k: string): string | null => (meta[k] ? meta[k] : null);
  return {
    shopName: meta.shop_name ?? 'My Mobile Shop',
    address: opt('address'),
    phone: opt('phone'),
    receiptFooter: opt('receipt_footer'),
    receiptFooterUr: opt('receipt_footer_ur'),
    cashierMaxDiscountBps: Number.isSafeInteger(bps) ? bps : 500,
    allowNegativeStock: meta.allow_negative_stock === '1',
  };
}

const metaUpsert = (key: string, value: string): Statement => ({
  sql: 'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  params: [key, value],
});

function shopFrom(meta: Record<string, string>, branchName: string): ShopInfo | null {
  if (!meta.device_id || !meta.branch_id || !meta.invoice_prefix) return null;
  return {
    deviceId: meta.device_id,
    branchId: meta.branch_id,
    branchName,
    invoicePrefix: meta.invoice_prefix,
    createdAt: Number(meta.created_at ?? 0),
    isDemo: meta.is_demo === '1',
  };
}

async function getShop(ctx: Ctx): Promise<ShopInfo> {
  const meta = await readMeta(ctx);
  const branch = meta.branch_id
    ? await one<{ name: string }>(ctx, 'SELECT name FROM branches WHERE id = ?', [meta.branch_id])
    : undefined;
  return shopFrom(meta, branch?.name ?? '') ?? fail('NOT_SETUP', 'Shop has not been set up yet');
}

function userInsert(
  ctx: Ctx,
  id: string,
  input: { username: string; displayName: string; role: Role; pin: string },
  t: number,
): Statement[] {
  const row: Record<string, SqlValue> = {
    id,
    username: input.username,
    display_name: input.displayName,
    role: input.role,
    pin_hash: hashPin(input.pin),
    is_active: 1,
    created_at: t,
    updated_at: t,
  };
  const { pin_hash: _omit, ...publicRow } = row;
  void _omit;
  return [insert('users', row), emit(ctx, 'user', id, publicRow, t)];
}

function validateNewUser(input: { username: unknown; displayName: unknown; pin: unknown }): {
  username: string;
  displayName: string;
  pin: string;
} {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!USERNAME.test(username))
    invalid('username', 'Use 3 to 32 lowercase letters, digits, dot, dash or underscore');
  return {
    username,
    displayName: text(input.displayName, 'displayName', 60),
    pin: checkPin(input.pin),
  };
}

export function setupApi(ctx: Ctx): PosService['setup'] {
  return {
    async isSetUp() {
      const meta = await readMeta(ctx);
      return Boolean(meta.device_id && meta.branch_id);
    },
    firstRun: (input) =>
      ctx.lock(async () => {
        const meta = await readMeta(ctx);
        if (meta.device_id) fail('ALREADY_SETUP', 'This shop is already set up');
        const shopName = text(input.shopName, 'shopName', 80);
        const branchName = text(input.branchName, 'branchName', 60);
        const prefix = typeof input.invoicePrefix === 'string' ? input.invoicePrefix.trim() : '';
        if (!PREFIX.test(prefix)) invalid('invoicePrefix', 'Use 1 to 4 capital letters or digits');
        const owner = validateNewUser(input.owner);

        const t = ctx.now();
        const deviceId = ctx.newId();
        const branchId = ctx.newId();
        const ownerId = ctx.newId();
        await write(ctx, [
          metaUpsert('device_id', deviceId),
          metaUpsert('branch_id', branchId),
          metaUpsert('invoice_prefix', prefix),
          metaUpsert('shop_name', shopName),
          metaUpsert('created_at', String(t)),
          metaUpsert('is_demo', '0'),
          metaUpsert('cashier_max_discount_bps', '500'),
          metaUpsert('allow_negative_stock', '0'),
          insert('branches', { id: branchId, name: branchName, created_at: t }),
          emit(ctx, 'branch', branchId, { id: branchId, name: branchName, createdAt: t }, t),
          ...userInsert(ctx, ownerId, { ...owner, role: 'owner' }, t),
        ]);
        return getShop(ctx);
      }),
    getShop: () => getShop(ctx),
  };
}

/** Marks the database as demo data (used by the seed). */
export const markDemo = (ctx: Ctx, isDemo: boolean): Promise<void> =>
  write(ctx, [metaUpsert('is_demo', isDemo ? '1' : '0')]);

export function settingsApi(ctx: Ctx): PosService['settings'] {
  return {
    async get() {
      return settingsFrom(await readMeta(ctx));
    },
    update: (patch) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'manage_settings');
        const stmts: Statement[] = [];
        for (const [k, v] of Object.entries(patch) as [keyof ShopSettings, unknown][]) {
          const key = SETTINGS_KEYS[k];
          if (!key) continue;
          let value: string;
          if (k === 'cashierMaxDiscountBps') value = String(intIn(v, k, 0, 10_000));
          else if (k === 'allowNegativeStock') value = v === true ? '1' : '0';
          else if (k === 'shopName') value = text(v, k, 80);
          else value = optText(v, k, 200) ?? '';
          stmts.push(metaUpsert(key, value));
        }
        if (stmts.length > 0) await write(ctx, stmts);
        return settingsFrom(await readMeta(ctx));
      }),
  };
}

export function authApi(ctx: Ctx): PosService['auth'] {
  const loadUser = (username: string): Promise<UserRow | undefined> =>
    one<UserRow>(ctx, 'SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);

  return {
    async listLoginUsers(): Promise<LoginUser[]> {
      const rows = await q<UserRow>(
        ctx,
        `SELECT * FROM users WHERE is_active = 1
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, display_name`,
      );
      return rows.map((r) => ({ username: r.username, displayName: r.display_name, role: r.role }));
    },
    async login(username, pin): Promise<Session> {
      const t = ctx.now();
      const f = ctx.loginFails.get(username) ?? { n: 0, until: 0 };
      if (f.until > t) fail('LOGIN_LOCKED', 'Too many attempts', { retryAfterMs: f.until - t });
      const u = await loadUser(username);
      if (!u || !verifyPin(String(pin), u.pin_hash)) {
        f.n += 1;
        if (f.n >= LOCK_AFTER) {
          f.n = 0;
          f.until = t + LOCK_MS;
        }
        ctx.loginFails.set(username, f);
        return fail('INVALID_CREDENTIALS', 'Wrong username or PIN');
      }
      ctx.loginFails.delete(username);
      ctx.session = { user: toUser(u), startedAt: t };
      return ctx.session;
    },
    logout() {
      ctx.session = null;
      ctx.grants.clear();
    },
    current: () => ctx.session,
    can: (permission) => can(ctx, permission),
    async requestApproval(pin): Promise<ApprovalGrant> {
      requireSession(ctx);
      const approvers = await q<UserRow>(
        ctx,
        "SELECT * FROM users WHERE is_active = 1 AND role IN ('owner', 'manager')",
      );
      const approver = approvers.find((u) => verifyPin(String(pin), u.pin_hash));
      if (!approver) return fail('APPROVAL_INVALID', 'Wrong manager PIN');
      const token = bytesToHex(randomBytes(16));
      const expiresAt = ctx.now() + ctx.approvalTtlMs;
      ctx.grants.set(token, { username: approver.username, expiresAt });
      return { token, approverUsername: approver.username, expiresAt };
    },
    changePin: (oldPin, newPin) =>
      ctx.lock(async () => {
        const s = requireSession(ctx);
        const u = await one<UserRow>(ctx, 'SELECT * FROM users WHERE id = ?', [s.user.id]);
        if (!u || !verifyPin(String(oldPin), u.pin_hash)) fail('INVALID_CREDENTIALS', 'Wrong PIN');
        const pin = checkPin(newPin, 'newPin');
        const t = ctx.now();
        await write(ctx, [
          {
            sql: 'UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?',
            params: [hashPin(pin), t, s.user.id],
          },
        ]);
      }),
    async listUsers() {
      requirePerm(ctx, 'manage_users');
      const rows = await q<UserRow>(ctx, 'SELECT * FROM users ORDER BY created_at');
      return rows.map(toUser);
    },
    createUser: (input) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'manage_users');
        if (!(ROLES as readonly string[]).includes(input.role)) invalid('role', 'Unknown role');
        const v = validateNewUser(input);
        const taken = await one(ctx, 'SELECT 1 AS x FROM users WHERE username = ?', [v.username]);
        if (taken) fail('DUPLICATE', 'Username taken', { field: 'username' });
        const id = ctx.newId();
        const t = ctx.now();
        await write(ctx, userInsert(ctx, id, { ...v, role: input.role }, t));
        const row = await one<UserRow>(ctx, 'SELECT * FROM users WHERE id = ?', [id]);
        return row ? toUser(row) : fail('INTERNAL', 'User was not saved');
      }),
  };
}
