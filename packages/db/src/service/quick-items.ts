import { MAX_QUICK_ITEMS, type ItemView } from '@pos/shared';
import { WriteBatch } from './batch';
import type { Ctx } from './deps';
import { invalid } from './errors';
import { uuid } from './item-history';
import { toItemView, type Raw } from './mappers';
import { META, deleteMeta, readMetaMap, upsertMeta } from './meta';
import { ITEM_VIEW_SQL, loadItemRec } from './queries';

/** Pinned ids in order; an unreadable stored value counts as nothing pinned rather than an error at the till. */
async function pinnedIds(ctx: Ctx): Promise<string[]> {
  const raw = (await readMetaMap(ctx.driver)).get(META.quickItems) ?? '';
  return raw.split(',').filter((id) => id !== '');
}

/** Active pinned items with their on-hand, in pin order. */
export async function loadQuickItems(ctx: Ctx, branchId: string): Promise<ItemView[]> {
  const ids = await pinnedIds(ctx);
  if (ids.length === 0) return [];
  const rows = await ctx.driver.query<Raw>(
    `${ITEM_VIEW_SQL} WHERE it.id IN (${ids.map(() => '?').join(', ')}) AND it.is_active = 1 AND p.is_active = 1`,
    [branchId, ...ids],
  );
  const byId = new Map(rows.map((r) => [String(r.id), toItemView(r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Caller has checked the permission. VALIDATION on a bad list, NOT_FOUND on an unknown item. */
export async function saveQuickItems(ctx: Ctx, itemIds: unknown): Promise<void> {
  if (!Array.isArray(itemIds)) throw invalid('itemIds', 'itemIds must be a list');
  if (itemIds.length > MAX_QUICK_ITEMS)
    throw invalid('itemIds', `At most ${MAX_QUICK_ITEMS} quick items`);
  const ids = itemIds.map((v, i) => uuid(v, `itemIds[${i}]`));
  if (new Set(ids).size !== ids.length) throw invalid('itemIds', 'An item is pinned twice');
  await ctx.lock(async () => {
    for (const id of ids) await loadItemRec(ctx.driver, id); // NOT_FOUND
    const b = new WriteBatch(ctx.newId, ctx.clock());
    const s =
      ids.length === 0 ? deleteMeta(META.quickItems) : upsertMeta(META.quickItems, ids.join(','));
    b.add(s.sql, s.params);
    await b.commit(ctx.driver);
  });
}
