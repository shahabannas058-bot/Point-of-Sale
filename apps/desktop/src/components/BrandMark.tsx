import type { ReactNode } from 'react';
import markUrl from '../assets/hs-pos-mark.png';

/** The HS POS shopping-bags mark on a light tile, so it reads on the dark sidebar and in the dark theme. */
export function BrandMark({ size = 40 }: { size?: number }): ReactNode {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-2xl bg-[#fbfcfc] shadow-[0_8px_20px_-8px_rgb(0_0_0/0.45)]"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img src={markUrl} alt="" width={Math.round(size * 0.62)} draggable={false} />
    </span>
  );
}
