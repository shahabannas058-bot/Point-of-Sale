/** Pointer-following shine for interactive glass (.btn-secondary, .pin-key, .glass-i): one passive listener
    writes the pointer position into --mx / --my on the element under it. Call once at startup. */
const SHINE_SELECTOR = '.btn-secondary, .pin-key, .glass-i';

export function installGlassShine(): void {
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>(SHINE_SELECTOR);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}
