import { describe, expect, it } from 'vitest';
import { MODULE_PRESETS } from '@pos/shared';
import { showsModelAndColour } from '../src/lib/item-fields';

describe('showsModelAndColour: "fits model" and colour are for mobile accessories only', () => {
  it('a kiryana (grocery) shop never sees them', () => {
    expect(showsModelAndColour(MODULE_PRESETS.kiryana)).toBe(false);
  });

  it('mobile, laptop and "everything" shops do', () => {
    expect(showsModelAndColour(MODULE_PRESETS.mobile)).toBe(true);
    expect(showsModelAndColour(MODULE_PRESETS.laptop)).toBe(true);
    expect(showsModelAndColour(MODULE_PRESETS.custom)).toBe(true);
  });

  it('a shop with no optional module at all does not', () => {
    expect(showsModelAndColour([])).toBe(false);
  });

  it('while the shop is still loading they are shown, so a mobile shop never sees them flicker away', () => {
    expect(showsModelAndColour(undefined)).toBe(true);
  });
});
