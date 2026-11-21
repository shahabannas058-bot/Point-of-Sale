import { describe, expect, it } from 'vitest';
import {
  CONFIRM_MS,
  DARK_FRAME,
  confirmRead,
  REPEAT_MS,
  cameraProblem,
  cleanScan,
  frameBrightness,
  trackScan,
} from '../src/lib/barcode-scan';

describe('cleanScan', () => {
  it('trims the decoded text and drops control characters', () => {
    expect(cleanScan('  8964000123457\r\n')).toBe('8964000123457');
    expect(cleanScan('ABC\u0000-12')).toBe('ABC-12');
  });

  it('rejects empty and absurdly long reads', () => {
    expect(cleanScan('')).toBeNull();
    expect(cleanScan(' \n ')).toBeNull();
    expect(cleanScan('9'.repeat(65))).toBeNull();
    expect(cleanScan('9'.repeat(64))).toBe('9'.repeat(64));
  });
});

describe('trackScan', () => {
  it('accepts the first read and a different code at once', () => {
    expect(trackScan(null, '111', 1000)).toEqual({ fresh: true, last: { code: '111', at: 1000 } });
    expect(trackScan({ code: '111', at: 1000 }, '222', 1001).fresh).toBe(true);
  });

  it('never counts a packet twice while it is held in front of the camera', () => {
    let last = trackScan(null, '111', 0).last;
    for (let now = 100; now <= 6000; now += 100) {
      const r = trackScan(last, '111', now);
      expect(r.fresh).toBe(false);
      last = r.last;
    }
  });

  it('counts the same code again once it was out of view for the pause', () => {
    const last = { code: '111', at: 1000 };
    expect(trackScan(last, '111', 1000 + REPEAT_MS - 1).fresh).toBe(false);
    expect(trackScan(last, '111', 1000 + REPEAT_MS).fresh).toBe(true);
  });
});

describe('cameraProblem', () => {
  const err = (name: string): Error => Object.assign(new Error(name), { name });

  it('maps getUserMedia errors to what the shopkeeper can do about them', () => {
    expect(cameraProblem(err('NotAllowedError'))).toBe('denied');
    expect(cameraProblem(err('SecurityError'))).toBe('denied');
    expect(cameraProblem(err('NotFoundError'))).toBe('missing');
    expect(cameraProblem(err('OverconstrainedError'))).toBe('missing');
    expect(cameraProblem(err('NotReadableError'))).toBe('busy');
    expect(cameraProblem(err('AbortError'))).toBe('busy');
  });

  it('falls back to a generic failure', () => {
    expect(cameraProblem(err('TypeError'))).toBe('failed');
    expect(cameraProblem('boom')).toBe('failed');
    expect(cameraProblem(undefined)).toBe('failed');
  });
});

describe('frameBrightness', () => {
  const frame = (v: number, px = 1000): Uint8ClampedArray =>
    new Uint8ClampedArray(px * 4).map((_, i) => (i % 4 === 3 ? 255 : v));

  it('tells a black frame from a real picture', () => {
    expect(frameBrightness(frame(0))).toBeLessThan(DARK_FRAME);
    expect(frameBrightness(frame(3))).toBeLessThan(DARK_FRAME);
    expect(frameBrightness(frame(120))).toBeCloseTo(120);
  });

  it('treats an empty frame as black', () => {
    expect(frameBrightness(new Uint8ClampedArray(0))).toBe(0);
  });
});

describe('confirmRead', () => {
  it('waits for a second identical read', () => {
    const first = confirmRead(null, '111', 0);
    expect(first.confirmed).toBe(false);
    expect(confirmRead(first.candidate, '111', 300)).toEqual({ confirmed: true, candidate: null });
  });

  it('drops a one-frame misread when the next frame says something else', () => {
    const wrong = confirmRead(null, '999', 0);
    const right = confirmRead(wrong.candidate, '111', 120);
    expect(right.confirmed).toBe(false);
    expect(right.candidate).toEqual({ code: '111', at: 120 });
    expect(confirmRead(right.candidate, '111', 240).confirmed).toBe(true);
  });

  it('does not pair reads that are too far apart', () => {
    const first = confirmRead(null, '111', 0);
    expect(confirmRead(first.candidate, '111', CONFIRM_MS + 1).confirmed).toBe(false);
  });
});
