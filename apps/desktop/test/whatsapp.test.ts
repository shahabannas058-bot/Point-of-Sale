import { describe, expect, it } from 'vitest';
import { waLink, waNumber } from '../src/lib/whatsapp';

describe('waNumber: Pakistani phones become international wa.me numbers', () => {
  it('turns a local 03xx number into 923xx', () => {
    expect(waNumber('03001234567')).toBe('923001234567');
    expect(waNumber('0300-1234567')).toBe('923001234567');
  });

  it('keeps an international number, with or without the plus or 00', () => {
    expect(waNumber('+923001234567')).toBe('923001234567');
    expect(waNumber('923001234567')).toBe('923001234567');
    expect(waNumber('00923001234567')).toBe('923001234567');
  });

  it('refuses empty or too-short phones', () => {
    expect(waNumber(null)).toBeNull();
    expect(waNumber(undefined)).toBeNull();
    expect(waNumber('')).toBeNull();
    expect(waNumber('12345')).toBeNull();
  });
});

describe('waLink', () => {
  it('encodes the message text', () => {
    expect(waLink('03001234567', 'Rs 1,500 baqi hai & shukriya')).toBe(
      'https://wa.me/923001234567?text=Rs%201%2C500%20baqi%20hai%20%26%20shukriya',
    );
  });

  it('is null without a usable phone', () => {
    expect(waLink(null, 'x')).toBeNull();
  });
});
