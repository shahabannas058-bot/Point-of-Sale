import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { migrate, migrationsFromFiles, type SqlDriver } from '@pos/db';
import { createPosService } from '@pos/db/service';
import { createSqlJsDriver } from '../src/db/sqljs-driver';
import { createRuntime, type DbHandle, type DbHost } from '../src/service/runtime';

/**
 * The runtime does not care where the database lives (browser sql.js, or the native file inside the desktop shell):
 * it is given a `DbHost`. These tests use in-memory sql.js databases and count what the host was asked to do.
 */
const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

async function emptyDb(): Promise<SqlDriver> {
  const SQL = await initSqlJs();
  const driver = createSqlJsDriver(new SQL.Database());
  await migrate(driver, migrationsFromFiles(files));
  return driver;
}

interface Spy extends DbHost {
  opened: number;
  resets: number;
}
/** `canReset` / `canExport` decide which optional abilities the host has, like the browser and the shell do. */
function hostOf(opts: { canReset: boolean; canExport: boolean; first?: SqlDriver }): Spy {
  const spy: Spy = {
    opened: 0,
    resets: 0,
    open: async () => {
      spy.opened += 1;
      return handle(opts.first ?? (await emptyDb()));
    },
  };
  const handle = (driver: SqlDriver): DbHandle => ({
    driver,
    ...(opts.canExport ? { exportBytes: () => new Uint8Array([spy.opened, spy.resets]) } : {}),
  });
  if (opts.canReset)
    spy.reset = async () => {
      spy.resets += 1;
      return handle(await emptyDb());
    };
  return spy;
}

const FAST = { pinIterations: 1000 };
const FRESH = { fresh: false, ...FAST };
const EMPTY = { fresh: true, ...FAST };

describe('createRuntime', () => {
  it('fills an empty database with the kiryana demo (kiryana is the first business type)', async () => {
    const rt = await createRuntime(hostOf({ canReset: true, canExport: true }), FRESH);
    const shop = await rt.service.setup.getShop();
    expect(shop).toMatchObject({ isDemo: true, businessType: 'kiryana' });
  });

  it('with fresh=true it leaves the database empty so the setup wizard shows', async () => {
    const rt = await createRuntime(hostOf({ canReset: true, canExport: true }), EMPTY);
    expect(await rt.service.setup.isSetUp()).toBe(false);
  });

  it('never seeds over a shop that already exists', async () => {
    const driver = await emptyDb();
    await createPosService({ driver, pinIterations: 1000 }).setup.firstRun({
      shopName: 'Ali Mobiles',
      branchName: 'Main',
      invoicePrefix: 'A',
      owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
      businessType: 'mobile',
    });
    const rt = await createRuntime(
      hostOf({ canReset: true, canExport: true, first: driver }),
      FRESH,
    );
    expect(await rt.service.setup.getShop()).toMatchObject({
      isDemo: false,
      businessType: 'mobile',
    });
  });

  it('loadDemo fills an empty database with the demo of the chosen business type', async () => {
    const rt = await createRuntime(hostOf({ canReset: true, canExport: true }), EMPTY);
    await rt.loadDemo('mobile');
    expect(await rt.service.setup.getShop()).toMatchObject({
      isDemo: true,
      businessType: 'custom',
    });

    const kiryana = await createRuntime(hostOf({ canReset: true, canExport: true }), EMPTY);
    await kiryana.loadDemo('kiryana');
    expect((await kiryana.service.setup.getShop()).businessType).toBe('kiryana');
  });

  it('resetDemo wipes the database through the host and reseeds the same business type', async () => {
    const host = hostOf({ canReset: true, canExport: true });
    const rt = await createRuntime(host, FRESH);
    await rt.service.auth.login('owner', '1234');
    const before = rt.service;

    await rt.resetDemo?.();

    expect(host.resets).toBe(1);
    expect(rt.service).not.toBe(before); // a new service over the new database
    expect(await rt.service.setup.getShop()).toMatchObject({
      isDemo: true,
      businessType: 'kiryana',
    });
    expect(rt.service.auth.current()).toBeNull(); // the old session is gone with the old database
  });

  it('a host that cannot reset (the desktop shell) gives a runtime without resetDemo', async () => {
    const rt = await createRuntime(hostOf({ canReset: false, canExport: false }), FRESH);
    expect(rt.resetDemo).toBeUndefined();
  });

  it('exportBytes exists only when the host can export, and always reads the current database', async () => {
    const without = await createRuntime(hostOf({ canReset: true, canExport: false }), FRESH);
    expect(without.exportBytes).toBeUndefined();

    const host = hostOf({ canReset: true, canExport: true });
    const rt = await createRuntime(host, FRESH);
    expect(rt.exportBytes?.()).toEqual(new Uint8Array([1, 0]));
    await rt.resetDemo?.();
    expect(rt.exportBytes?.()).toEqual(new Uint8Array([1, 1]));
  });
});
