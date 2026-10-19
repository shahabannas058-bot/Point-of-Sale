export interface ReorderInput {
  onHand: number;
  reorderLevel: number;
  /** Net units sold in the window (never negative). */
  sold: number;
  /** Window length in days. */
  days: number;
  /** Days of sales an order should cover on top of the reorder level. */
  coverDays: number;
  /** Items that run out within this many days need a reorder even above their level. */
  leadDays: number;
}

export interface ReorderFigures {
  /** sold / days, 2 decimals (display only). */
  dailyAvg: number;
  /** Whole days of stock left at the current rate; null when nothing sold. */
  daysLeft: number | null;
  /** max(0, reorderLevel + ceil(sold * coverDays / days) - onHand). */
  suggestedQty: number;
  needsReorder: boolean;
}

/** Reorder maths shared by the SQLite service and the in-memory mock. Integer maths only, so
    38 units at 2 sold per 30 days is 570 days, not 569 (38 / (2 / 30) = 569.999... as a float). */
export function reorderFigures(i: ReorderInput): ReorderFigures {
  const sold = Math.max(0, i.sold);
  const onHand = Math.max(0, i.onHand);
  const daysLeft = sold > 0 ? Math.floor((onHand * i.days) / sold) : null;
  const cover = Math.floor((sold * i.coverDays + i.days - 1) / i.days);
  return {
    dailyAvg: Math.round((sold * 100) / i.days) / 100,
    daysLeft,
    suggestedQty: Math.max(0, i.reorderLevel + cover - i.onHand),
    needsReorder: i.onHand <= i.reorderLevel || (daysLeft !== null && daysLeft <= i.leadDays),
  };
}

export interface ReorderRank {
  daysLeft: number | null;
  onHand: number;
  reorderLevel: number;
  label: string;
}

/** Most urgent first: fewest days left (unknown last), then furthest below the level, then by name. */
export function compareReorder(a: ReorderRank, b: ReorderRank): number {
  const left = (r: ReorderRank): number => r.daysLeft ?? Number.POSITIVE_INFINITY;
  if (left(a) !== left(b)) return left(a) < left(b) ? -1 : 1;
  const gap = a.onHand - a.reorderLevel - (b.onHand - b.reorderLevel);
  return gap !== 0 ? gap : a.label.localeCompare(b.label);
}
