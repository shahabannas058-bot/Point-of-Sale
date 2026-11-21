/*
 * Pure helpers for scanning barcodes with the laptop / USB camera. The decoder itself (zxing-wasm) lives in
 * barcode-decoder.ts so these stay testable in Node.
 */

/**
 * The same code held in front of the camera is read many times a second. It counts again only after it has been out
 * of view (no read of it) for this long, so holding a packet still never adds it twice.
 */
export const REPEAT_MS = 2000;

/** Longest text we accept as a barcode; anything longer is a misread or a QR with a sentence in it. */
const MAX_CODE = 64;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Trimmed code without control characters, or null when the read is empty or too long. */
export function cleanScan(text: string): string | null {
  const code = text.replace(CONTROL, '').trim();
  return code.length === 0 || code.length > MAX_CODE ? null : code;
}

export interface LastScan {
  code: string;
  at: number;
}

/**
 * Whether this read should count, plus the state to keep for the next frame. Every read of the same code pushes its
 * time forward, so the pause is measured from the last time the code was seen, not from when it was first added.
 */
export function trackScan(
  last: LastScan | null,
  code: string,
  now: number,
): { fresh: boolean; last: LastScan } {
  const fresh = last === null || last.code !== code || now - last.at >= REPEAT_MS;
  return { fresh, last: { code, at: now } };
}

/** A first read waits this long for a second, identical read before it counts. */
export const CONFIRM_MS = 1500;

export interface Candidate {
  code: string;
  at: number;
}

/**
 * A blurry frame can decode to a wrong number that still passes the check digit, but two separate frames almost
 * never agree on the same wrong number. So a read counts only when the previous read (within CONFIRM_MS) had the
 * same text.
 */
export function confirmRead(
  candidate: Candidate | null,
  code: string,
  now: number,
): { confirmed: boolean; candidate: Candidate | null } {
  if (candidate !== null && candidate.code === code && now - candidate.at <= CONFIRM_MS)
    return { confirmed: true, candidate: null };
  return { confirmed: false, candidate: { code, at: now } };
}

/** Average brightness (0–255) of every `step`-th pixel of an RGBA frame. */
export function frameBrightness(rgba: Uint8ClampedArray, step = 97): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgba.length; i += step * 4) {
    sum += ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0)) / 3;
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/** Below this the picture is black: lens covered, privacy shutter closed, or another app holds the camera. */
export const DARK_FRAME = 8;

export type CameraProblem = 'denied' | 'missing' | 'busy' | 'unsupported' | 'failed';

/** Turns a getUserMedia error into the message key the shopkeeper sees (scan.<problem>). */
export function cameraProblem(e: unknown): CameraProblem {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}
