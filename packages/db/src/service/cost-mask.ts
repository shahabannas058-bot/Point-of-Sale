import { paisa } from '@pos/core';
import type { Invoice, ItemView } from '@pos/shared';
import { canDo, type Ctx } from './deps';

/*
 * Cost prices leave the service only for a session with view_cost. Without it the cost is sent as 0, which keeps the
 * contract's non-negative paisa (ItemSchema / SaleLineSchema). Only output is masked: stored rows and the service's
 * own reads (pricing, returns, reports) always use the real cost.
 */

const showCost = (ctx: Ctx): boolean => canDo(ctx, 'view_cost');

export const itemViewForSession = (ctx: Ctx, v: ItemView): ItemView =>
  showCost(ctx) ? v : { ...v, item: { ...v.item, costPrice: paisa(0) } };

export const itemViewsForSession = (ctx: Ctx, views: readonly ItemView[]): ItemView[] =>
  views.map((v) => itemViewForSession(ctx, v));

export const invoiceForSession = (ctx: Ctx, inv: Invoice): Invoice =>
  showCost(ctx) ? inv : { ...inv, lines: inv.lines.map((l) => ({ ...l, costPrice: paisa(0) })) };
