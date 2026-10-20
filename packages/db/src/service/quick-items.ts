import { MAX_QUICK_ITEMS, type VariantView } from '@pos/shared';
import { WriteBatch } from './batch';
import type { Ctx } from './deps';
import { invalid } from './errors';
import { uuid } from './item-history';
import { toVariantView, type Raw } from './mappers';
import { META, deleteMeta, readMetaMap, upsertMeta } from './meta';
import { VARIANT_VIEW_SQL, loadVariantRec } from './queries';

/** Pinned ids in order; an unreadable stored value counts as nothing pinned rather than an error at the till. */
async function pinnedIds(ctx: Ctx): Promise<string[]> {
  const raw = (await readMetaMap(ctx.driver)).get(META.quickItems) ?? '';
  return raw.split(',').filter((id) => id !== '');
}

/** Active pinned variants with their on-hand, in pin order. */
export async function loadQuickItems(ctx: Ctx, branchId: string): Promise<VariantView[]> {
  const ids = await pinnedIds(ctx);
  if (ids.length === 0) return [];
  const rows = await ctx.driver.query<Raw>(
    `${VARIANT_VIEW_SQL} WHERE av.id IN (${ids.map(() => '?').join(', ')}) AND av.is_active = 1 AND p.is_active = 1`,
    [branchId, ...ids],
  );
  const byId = new Map(rows.map((r) => [String(r.id), toVariantView(r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Caller has checked the permission. VALIDATION on a bad list, NOT_FOUND on an unknown variant. */
export async function saveQuickItems(ctx: Ctx, variantIds: unknown): Promise<void> {
  if (!Array.isArray(variantIds)) throw invalid('variantIds', 'variantIds must be a list');
  if (variantIds.length > MAX_QUICK_ITEMS)
    throw invalid('variantIds', `At most ${MAX_QUICK_ITEMS} quick items`);
  const ids = variantIds.map((v, i) => uuid(v, `variantIds[${i}]`));
  if (new Set(ids).size !== ids.length) throw invalid('variantIds', 'An item is pinned twice');
  await ctx.lock(async () => {
    for (const id of ids) await loadVariantRec(ctx.driver, id); // NOT_FOUND
    const b = new WriteBatch(ctx.newId, ctx.clock());
    const s =
      ids.length === 0 ? deleteMeta(META.quickItems) : upsertMeta(META.quickItems, ids.join(','));
    b.add(s.sql, s.params);
    await b.commit(ctx.driver);
  });
}
