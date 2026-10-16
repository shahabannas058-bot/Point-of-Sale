/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// vitest stubs CSS imports (even ?raw) to an empty string, so read the file directly.
const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out[m[1] ?? ''] = (m[2] ?? '').trim();
  return out;
}

function blockAfter(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

const light = declarations(blockAfter(css, ':root {'));
const darkExplicit = declarations(blockAfter(css, ":root[data-theme='dark']"));
const darkMedia = declarations(blockAfter(css, ":root:not([data-theme='light'])"));

const luminance = (hex: string): number => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe('design tokens', () => {
  it('the OS-preference dark block matches the explicit [data-theme=dark] block exactly', () => {
    expect(darkMedia).toEqual(darkExplicit);
  });

  it('dark redefines every colour token of light (no colour leaks through from light)', () => {
    const colourKeys = Object.keys(light).filter(
      (k) => /^#/.test(light[k] ?? '') || (light[k] ?? '').startsWith('rgb'),
    );
    for (const k of colourKeys) expect(darkExplicit, `dark is missing ${k}`).toHaveProperty(k);
  });

  it('uses the blueprint values for the core tokens', () => {
    expect(light['--primary']).toBe('#1d4ed8');
    expect(light['--text']).toBe('#0f172a');
    expect(darkExplicit['--bg']).toBe('#0b1220');
    expect(darkExplicit['--primary']).toBe('#60a5fa');
  });

  it('body text meets WCAG AA (4.5:1) on every surface, in both themes', () => {
    for (const [name, t] of [
      ['light', light],
      ['dark', darkExplicit],
    ] as const) {
      for (const surface of ['--bg', '--surface', '--surface-2']) {
        expect(
          contrast(t['--text'] ?? '', t[surface] ?? ''),
          `${name} text on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(t['--text-muted'] ?? '', t[surface] ?? ''),
          `${name} muted on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('primary buttons and semantic badges are readable (>= 4.5:1)', () => {
    for (const [name, t] of [
      ['light', light],
      ['dark', darkExplicit],
    ] as const) {
      expect(
        contrast(t['--on-primary'] ?? '', t['--primary'] ?? ''),
        `${name} on-primary`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const tone of ['primary', 'success', 'warning', 'danger']) {
        expect(
          contrast(t[`--${tone}-ink`] ?? '', t[`--${tone}-soft`] ?? ''),
          `${name} ${tone} badge`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('totals text reaches AAA (7:1) on the surface', () => {
    expect(contrast(light['--text'] ?? '', light['--surface'] ?? '')).toBeGreaterThanOrEqual(7);
    expect(
      contrast(darkExplicit['--text'] ?? '', darkExplicit['--surface'] ?? ''),
    ).toBeGreaterThanOrEqual(7);
  });
});
