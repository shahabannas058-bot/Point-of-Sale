import type { SqlDriver } from '@pos/db';
import { createPosService, seedDemoData } from '@pos/db/service';
import type { AppRuntime } from './context';

/** An open database: the driver the service runs on, and (where possible) a way to copy the raw bytes. */
export interface DbHandle {
  driver: SqlDriver;
  exportBytes?: () => Uint8Array;
}

/**
 * Where the shop database lives. The browser host keeps sql.js bytes in IndexedDB; the desktop-shell host talks to the
 * native `pos.db` through the WebView2 bridge (ADR-0010). The runtime does not know which one it has.
 */
export interface DbHost {
  /** Opens the database, creating and migrating it if the host is the one that owns the schema. */
  open(): Promise<DbHandle>;
  /**
   * Wipes the database and opens an empty one. Left out where wiping is not allowed: the native shell's sales and stock
   * tables are append-only, and a shop's real data must never be one button away from deletion.
   */
  reset?: () => Promise<DbHandle>;
}

export interface RuntimeOptions {
  /** True (`?fresh=1`) = do not seed an empty database, so the first-run wizard is shown. */
  fresh: boolean;
  /** Only for tests: fewer PBKDF2 rounds make the demo seed fast. */
  pinIterations?: number;
}

/** Opens the database and builds the runtime. An empty database is filled with the kiryana demo unless `fresh`. */
export async function createRuntime(host: DbHost, opts: RuntimeOptions): Promise<AppRuntime> {
  const deps = (h: DbHandle) => ({
    driver: h.driver,
    ...(opts.pinIterations === undefined ? {} : { pinIterations: opts.pinIterations }),
  });

  let handle = await host.open();
  let service = createPosService(deps(handle));
  if (!opts.fresh && !(await service.setup.isSetUp())) {
    await seedDemoData(deps(handle), { businessType: 'kiryana' });
    service = createPosService(deps(handle));
  }

  const reset = host.reset;
  return {
    get service() {
      return service;
    },
    get exportBytes() {
      return handle.exportBytes;
    },
    loadDemo: async (businessType) => {
      await seedDemoData(deps(handle), { businessType });
      service = createPosService(deps(handle));
    },
    ...(reset === undefined
      ? {}
      : {
          resetDemo: async () => {
            // keep the demo flavour: a kiryana demo is reseeded as kiryana, not as the mobile shop
            const { businessType } = await service.setup.getShop();
            handle = await reset();
            await seedDemoData(deps(handle), { businessType });
            service = createPosService(deps(handle));
          },
        }),
  };
}
