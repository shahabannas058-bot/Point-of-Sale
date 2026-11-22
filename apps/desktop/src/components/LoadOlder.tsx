import type { ReactNode } from 'react';
import type { OlderPages } from '../service/use-older-pages';
import { Button } from './ui/Button';
import { ErrorBox } from './ui/misc';

/** The footer under a paged list: "load older" while more rows exist, a quiet note once the end is reached. */
export function LoadOlder({
  pages,
  label,
  endLabel,
}: {
  pages: Pick<OlderPages<unknown>, 'hasMore' | 'ended' | 'busy' | 'error' | 'loadMore'>;
  label: string;
  endLabel: string;
}): ReactNode {
  return (
    <div className="no-print mt-3 flex flex-col items-center gap-2">
      {pages.error !== undefined ? (
        <ErrorBox error={pages.error} onRetry={() => void pages.loadMore()} />
      ) : null}
      {pages.hasMore ? (
        <Button variant="secondary" loading={pages.busy} onClick={() => void pages.loadMore()}>
          {label}
        </Button>
      ) : pages.ended ? (
        <p className="text-sm text-muted">{endLabel}</p>
      ) : null}
    </div>
  );
}
