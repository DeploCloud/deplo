import { defaultVariant, type CatalogTemplate } from "@/templates/types";

/** FNV-1a over the slug: a stable starting point per template, so the fillers
 *  are the same six on every render instead of reshuffling under the pointer. */
function offset(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i += 1) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The siblings shown under a template: its own category first, then topped up
 * from the rest of the catalogue so a row is never one lonely card.
 */
export function pickRelated(
  catalog: CatalogTemplate[],
  slug: string,
  categorySlug: string,
  min = 6,
  max = 12,
): CatalogTemplate[] {
  const others = catalog.filter((t) => t.slug !== slug);
  const picks = others
    .filter((t) => defaultVariant(t).category.slug === categorySlug)
    .slice(0, max);
  if (picks.length >= min) return picks;

  const taken = new Set(picks.map((t) => t.slug));
  const pool = others
    .filter((t) => !taken.has(t.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const start = pool.length ? offset(slug) % pool.length : 0;
  for (let i = 0; i < pool.length && picks.length < min; i += 1)
    picks.push(pool[(start + i) % pool.length]);
  return picks;
}
