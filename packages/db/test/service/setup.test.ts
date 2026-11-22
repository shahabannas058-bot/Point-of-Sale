import { describe, expect, it } from 'vitest';
import type { SetupInput, ShopSettings } from '@pos/shared';
import { expectCode, makeService } from './helpers';

const BASE = { shopName: 'S', branchName: 'B', invoicePrefix: 'A' };

describe('setup.firstRun validates the shape of its input', () => {
  it('a missing owner is VALIDATION {field: owner}, not INTERNAL, and nothing is set up', async () => {
    const t = await makeService({ seed: false });
    const e = await expectCode(t.svc.setup.firstRun(BASE as SetupInput), 'VALIDATION');
    expect(e.details).toMatchObject({ field: 'owner' });
    expect(await t.svc.setup.isSetUp()).toBe(false);
  });

  it('an owner that is not an object, or no input at all, is VALIDATION', async () => {
    const t = await makeService({ seed: false });
    await expectCode(
      t.svc.setup.firstRun({ ...BASE, owner: 'owner' } as unknown as SetupInput),
      'VALIDATION',
    );
    await expectCode(t.svc.setup.firstRun(null as unknown as SetupInput), 'VALIDATION');
  });
});

describe('settings.update validates the shape of its patch', () => {
  it('a patch that is not an object is VALIDATION, not INTERNAL', async () => {
    const t = await makeService();
    await t.loginAs('owner');
    const e = await expectCode(
      t.svc.settings.update(null as unknown as Partial<ShopSettings>),
      'VALIDATION',
    );
    expect(e.details).toMatchObject({ field: 'patch' });
  });
});
