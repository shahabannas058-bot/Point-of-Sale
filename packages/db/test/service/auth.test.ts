import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '@pos/shared';
import {
  IMEI_Y,
  PINS,
  expectCode,
  first,
  makeService,
  type TestService,
  type TestUser,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

describe('login (spec 10)', () => {
  it('a wrong PIN and an unknown user give the same INVALID_CREDENTIALS', async () => {
    const wrong = await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    const unknown = await expectCode(t.svc.auth.login('nobody', '1234'), 'INVALID_CREDENTIALS');
    expect(unknown.message).toBe(wrong.message);
    expect(t.svc.auth.current()).toBeNull();
  });

  it('non-numeric or empty PINs are refused without crashing', async () => {
    await expectCode(t.svc.auth.login('owner', ''), 'INVALID_CREDENTIALS');
    await expectCode(t.svc.auth.login('owner', 'abcd'), 'INVALID_CREDENTIALS');
    await expectCode(
      t.svc.auth.login('owner', undefined as unknown as string),
      'INVALID_CREDENTIALS',
    );
  });

  it('usernames are case-insensitive and trimmed', async () => {
    const s = await t.svc.auth.login('  OWNER ', PINS.owner);
    expect(s.user.username).toBe('owner');
    expect(s.user.role).toBe('owner');
  });

  it('a session never exposes the PIN hash', async () => {
    const s = await t.svc.auth.login('owner', PINS.owner);
    expect(JSON.stringify(s)).not.toMatch(/pbkdf2|pin_hash|pinHash/);
    const users = await t.svc.auth.listUsers();
    expect(JSON.stringify(users)).not.toMatch(/pbkdf2|pin_hash|pinHash/);
  });

  it('5 wrong PINs: the 5th is INVALID_CREDENTIALS, the 6th (even correct) is LOGIN_LOCKED, 30 s later it works', async () => {
    for (let i = 1; i <= 5; i += 1)
      await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    const locked = await expectCode(t.svc.auth.login('owner', PINS.owner), 'LOGIN_LOCKED');
    expect(locked.details.retryAfterMs).toEqual(expect.any(Number));
    expect(locked.details.retryAfterMs as number).toBeGreaterThan(0);
    expect(locked.details.retryAfterMs as number).toBeLessThanOrEqual(30_000);
    expect(t.svc.auth.current()).toBeNull();

    t.clock.advance(30_000);
    const s = await t.svc.auth.login('owner', PINS.owner);
    expect(s.user.username).toBe('owner');
  });

  it('the lock is per username: another user can still log in', async () => {
    for (let i = 0; i < 5; i += 1)
      await expectCode(t.svc.auth.login('cash', '0000'), 'INVALID_CREDENTIALS');
    await expectCode(t.svc.auth.login('cash', PINS.cash), 'LOGIN_LOCKED');
    await t.svc.auth.login('mgr', PINS.mgr);
  });

  it('a successful login resets the failure counter', async () => {
    for (let i = 0; i < 4; i += 1)
      await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    await t.svc.auth.login('owner', PINS.owner);
    t.svc.auth.logout();
    for (let i = 0; i < 4; i += 1)
      await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    await t.svc.auth.login('owner', PINS.owner); // still not locked
  });

  it('after the lock expires, a fresh wrong PIN does not instantly re-lock', async () => {
    for (let i = 0; i < 5; i += 1)
      await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    t.clock.advance(31_000);
    await expectCode(t.svc.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    await t.svc.auth.login('owner', PINS.owner);
  });

  it('an inactive user cannot log in', async () => {
    await t.driver.exec("UPDATE users SET is_active = 0 WHERE username = 'cash'");
    await expectCode(t.svc.auth.login('cash', PINS.cash), 'INVALID_CREDENTIALS');
    expect((await t.svc.auth.listLoginUsers()).map((u) => u.username)).toEqual(['owner', 'mgr']);
  });

  it('listLoginUsers is public and orders owner, manager, cashier', async () => {
    const users = await t.svc.auth.listLoginUsers();
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['owner', 'owner'],
      ['mgr', 'manager'],
      ['cash', 'cashier'],
    ]);
  });

  it('logout clears the session and any approval grants', async () => {
    await t.loginAs('cash');
    const grant = await t.svc.auth.requestApproval('2345');
    expect(t.svc.auth.current()?.user.username).toBe('cash');
    t.svc.auth.logout();
    expect(t.svc.auth.current()).toBeNull();
    expect(t.svc.auth.can('sell')).toBe(false);
    await t.loginAs('cash');
    // the old token is gone, so a discount needing approval still asks for it
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 1_000_000 }],
        payments: [{ method: 'cash', amount: 7_500_000 }],
        approvalToken: grant.token,
      }),
      'APPROVAL_REQUIRED',
    );
  });
});

describe('approval requests', () => {
  it('needs a session', async () => {
    await expectCode(t.svc.auth.requestApproval('2345'), 'NOT_AUTHENTICATED');
  });

  it('a manager or owner PIN yields a 60 s grant; the cashier own PIN does not', async () => {
    await t.loginAs('cash');
    const before = t.clock.peek();
    const g = await t.svc.auth.requestApproval('2345');
    expect(g.approverUsername).toBe('mgr');
    expect(g.token).toMatch(/^[0-9a-f]{32}$/);
    expect(g.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(g.expiresAt).toBeLessThanOrEqual(t.clock.peek() + 60_000);
    const o = await t.svc.auth.requestApproval('1234');
    expect(o.approverUsername).toBe('owner');
    expect(o.token).not.toBe(g.token);
    await expectCode(t.svc.auth.requestApproval('3456'), 'APPROVAL_INVALID');
    await expectCode(t.svc.auth.requestApproval('abc'), 'APPROVAL_INVALID');
  });

  it('shares the throttle semantics: 5th wrong is APPROVAL_INVALID, 6th even correct is LOGIN_LOCKED, then 30 s later it works', async () => {
    await t.loginAs('cash');
    for (let i = 0; i < 5; i += 1)
      await expectCode(t.svc.auth.requestApproval('0000'), 'APPROVAL_INVALID');
    const locked = await expectCode(t.svc.auth.requestApproval('2345'), 'LOGIN_LOCKED');
    expect(locked.details.retryAfterMs as number).toBeGreaterThan(0);
    t.clock.advance(30_000);
    const g = await t.svc.auth.requestApproval('2345');
    expect(g.approverUsername).toBe('mgr');
  });
});

describe('roles and permissions (spec 10)', () => {
  it('without a session everything is NOT_AUTHENTICATED', async () => {
    await expectCode(t.svc.checkout.preview({ lines: [] }), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.catalog.search('x'), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.catalog.listPhones(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.settings.get(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.auth.listUsers(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.integrity.verifyChain(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.purchasing.listSuppliers(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.auth.changePin('1234', '5555'), 'NOT_AUTHENTICATED');
  });

  it('a cashier cannot create phones, summarise reports, adjust stock, manage users or settings', async () => {
    await t.loginAs('cash');
    await expectCode(
      t.svc.catalog.createPhoneUnit({
        product: { brand: 'X', name: 'Y' },
        imei1: IMEI_Y,
        ptaStatus: 'approved',
        condition: 'new',
        costPrice: 1,
        salePrice: 2,
      }),
      'FORBIDDEN',
    );
    await expectCode(t.svc.reports.summary({ fromMs: 0, toMs: 1 }), 'FORBIDDEN');
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: 1, reason: 'x' }),
      'FORBIDDEN',
    );
    await expectCode(t.svc.auth.listUsers(), 'FORBIDDEN');
    await expectCode(
      t.svc.auth.createUser({ username: 'abc', displayName: 'A', role: 'cashier', pin: '1111' }),
      'FORBIDDEN',
    );
    await expectCode(t.svc.settings.update({ shopName: 'Mine' }), 'FORBIDDEN');
  });

  it('a manager can do catalog and reports but not manage users or settings', async () => {
    await t.loginAs('mgr');
    await t.svc.reports.summary({ fromMs: 0, toMs: 1 });
    await expectCode(t.svc.auth.listUsers(), 'FORBIDDEN');
    await expectCode(t.svc.settings.update({ shopName: 'Mine' }), 'FORBIDDEN');
  });

  it('auth.can mirrors ROLE_PERMISSIONS for every role', async () => {
    const roles: Record<TestUser, 'owner' | 'manager' | 'cashier'> = {
      owner: 'owner',
      mgr: 'manager',
      cash: 'cashier',
    };
    for (const user of ['owner', 'mgr', 'cash'] as const) {
      t.svc.auth.logout();
      await t.loginAs(user);
      for (const p of PERMISSIONS)
        expect(t.svc.auth.can(p), `${user}:${p}`).toBe(ROLE_PERMISSIONS[roles[user]].includes(p));
    }
  });
});

describe('user management and PIN change', () => {
  it('the owner can create and list users', async () => {
    await t.loginAs('owner');
    const u = await t.svc.auth.createUser({
      username: 'Ali.Raza',
      displayName: 'Ali',
      role: 'cashier',
      pin: '654321',
    });
    expect(u).toMatchObject({ username: 'ali.raza', role: 'cashier', isActive: true });
    expect((await t.svc.auth.listUsers()).map((x) => x.username)).toEqual([
      'owner',
      'mgr',
      'ali.raza',
      'cash',
    ]);
    t.svc.auth.logout();
    await t.svc.auth.login('ali.raza', '654321');
  });

  it('validates username, role and PIN; a duplicate username is DUPLICATE', async () => {
    await t.loginAs('owner');
    const mk = (over: Record<string, unknown>) =>
      t.svc.auth.createUser({
        username: 'newuser',
        displayName: 'N',
        role: 'cashier',
        pin: '1111',
        ...over,
      });
    await expectCode(mk({ username: 'ab' }), 'VALIDATION');
    await expectCode(mk({ username: 'has space' }), 'VALIDATION');
    await expectCode(mk({ role: 'god' }), 'VALIDATION');
    await expectCode(mk({ pin: '12' }), 'VALIDATION');
    await expectCode(mk({ pin: '1234567' }), 'VALIDATION');
    await expectCode(mk({ pin: 'abcd' }), 'VALIDATION');
    const dup = await expectCode(mk({ username: 'cash' }), 'DUPLICATE');
    expect(dup.details).toMatchObject({ field: 'username' });
  });

  it('changePin needs the old PIN and the new one works afterwards', async () => {
    await t.loginAs('cash');
    await expectCode(t.svc.auth.changePin('0000', '7777'), 'INVALID_CREDENTIALS');
    await expectCode(t.svc.auth.changePin('3456', '12'), 'VALIDATION');
    await t.svc.auth.changePin('3456', '7777');
    t.svc.auth.logout();
    await expectCode(t.svc.auth.login('cash', '3456'), 'INVALID_CREDENTIALS');
    await t.svc.auth.login('cash', '7777');
  });

  it('stores only salted PBKDF2 hashes: equal PINs give different hashes', async () => {
    await t.loginAs('owner');
    await t.svc.auth.createUser({
      username: 'twin1',
      displayName: 'T',
      role: 'cashier',
      pin: '9999',
    });
    await t.svc.auth.createUser({
      username: 'twin2',
      displayName: 'T',
      role: 'cashier',
      pin: '9999',
    });
    const rows = await t.driver.query<{ pin_hash: string }>(
      "select pin_hash from users where username in ('twin1','twin2')",
    );
    expect(rows).toHaveLength(2);
    expect(first(rows).pin_hash).toMatch(/^pbkdf2\$sha256\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(rows[0]?.pin_hash).not.toBe(rows[1]?.pin_hash);
    expect(JSON.stringify(rows)).not.toContain('9999');
  });
});
