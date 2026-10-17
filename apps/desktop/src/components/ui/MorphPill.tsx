import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * A glass pill that slides and stretches between siblings to mark the selected one (the web version of
 * Liquid Glass morphing inside a GlassEffectContainer). The container needs `position: relative` and
 * `isolation: isolate`; it gets `data-morph` so CSS can drop the item's own selected background.
 */
export function MorphPill({
  containerRef,
  selector,
  watch,
}: {
  containerRef: RefObject<HTMLElement | null>;
  /** CSS selector of the selected item inside the container. */
  selector: string;
  /** Re-measure when this changes (e.g. the selected value or route). */
  watch: unknown;
}): ReactNode {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ready = useRef(false);

  useLayoutEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    host.setAttribute('data-morph', '');
    const measure = (): void => {
      const el = host.querySelector<HTMLElement>(selector);
      if (!el) return setBox(null);
      // offset* is relative to the container and ignores the RTL mirror, so translate stays physical
      setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => {
      ro.disconnect();
      host.removeAttribute('data-morph');
    };
  }, [containerRef, selector, watch]);

  useLayoutEffect(() => {
    // skip the slide-in on first paint; later moves animate
    if (box) requestAnimationFrame(() => (ready.current = true));
  }, [box]);

  if (!box) return null;
  const style: CSSProperties = {
    width: box.w,
    height: box.h,
    transform: `translate(${box.x}px, ${box.y}px)`,
    transition: ready.current ? undefined : 'none',
  };
  return <span className="morph-pill" aria-hidden="true" style={style} />;
}
