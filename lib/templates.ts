/**
 * One-click template catalog. Generated into templates/catalog.json by
 * scripts/import-templates.mjs and consumed here. Each template maps to a
 * docker-compose stack under templates/blueprints/<id>/.
 */
import catalog from "@/templates/catalog.json";

export interface CatalogTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  logo: string | null;
  links: {
    github?: string;
    website?: string;
    docs?: string;
  };
  version: string;
  popular: boolean;
}

export const TEMPLATES = catalog as CatalogTemplate[];

export function getTemplate(id: string): CatalogTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Most common tags across the catalog, for filter chips. */
export function topTags(limit = 16): string[] {
  const counts = new Map<string, number>();
  for (const t of TEMPLATES)
    for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}
