import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { BrandMark } from './BrandMark';

/** Full-screen splash / blocking message used before the app is mounted. */
export function Loader({
  title,
  label,
  still = false,
}: {
  title?: string;
  label: string;
  still?: boolean;
}): ReactNode {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <BrandMark size={64} />
        {title ? <h1 className="text-xl">{title}</h1> : null}
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          {still ? null : <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          {label}
        </p>
      </div>
    </div>
  );
}
