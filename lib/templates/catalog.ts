import "server-only";

import { z } from "zod";
import { MAX_LOGO_BYTES } from "@/lib/apps/logo-shared";
import { templatesApiBase } from "./api-base";
import {
  apiTemplateSchema,
  slugSchema,
  templateAssetPathSchema,
  templateListQuerySchema,
  templatesResponseSchema,
} from "./schema";
import type { ApiTemplate, CatalogTemplate, TemplateListQuery } from "./types";

const CATALOG_TTL = 300;
const FEATURED_TTL = 60;
const IMAGE_TTL = 3600;

function apiUrl(path: string): string {
  return `${templatesApiBase()}${path}`;
}

export function templateAssetUrl(path: string): string {
  return apiUrl(templateAssetPathSchema.parse(path));
}

function get(
  url: string,
  accept: string,
  revalidate = CATALOG_TTL,
  tags = ["templates"],
) {
  return fetch(url, {
    headers: { Accept: accept },
    cache: "force-cache",
    next: { revalidate, tags },
  });
}

async function fetchJson<T>(
  path: string,
  schema: z.ZodType<T>,
  revalidate = CATALOG_TTL,
): Promise<T> {
  const response = await get(apiUrl(path), "application/json", revalidate);
  if (!response.ok)
    throw new Error(`Template catalog returned ${response.status}.`);
  return schema.parse(await response.json());
}

async function fetchText(path: string, slug: string): Promise<string> {
  const response = await get(
    templateAssetUrl(path),
    "text/plain",
    CATALOG_TTL,
    ["templates", `template:${slug}`],
  );
  if (!response.ok)
    throw new Error(`Template catalog returned ${response.status}.`);
  return response.text();
}

export async function getTemplates(query: TemplateListQuery = {}) {
  const parsed = templateListQuerySchema.parse(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed))
    if (value !== undefined) params.set(key, String(value));
  return fetchJson(
    `/templates?${params}`,
    templatesResponseSchema,
    parsed.featured ? FEATURED_TTL : CATALOG_TTL,
  );
}

function withAssetUrls(t: ApiTemplate): CatalogTemplate {
  return {
    ...t,
    logo: t.logo ? templateAssetUrl(t.logo) : null,
    variants: t.variants.map((variant) => ({
      ...variant,
      logo: variant.logo ? templateAssetUrl(variant.logo) : null,
      images: variant.images.map(templateAssetUrl),
    })),
  };
}

export async function listFeaturedTemplates(
  limit: number,
): Promise<CatalogTemplate[]> {
  const page = await getTemplates({ featured: true, limit });
  return page.data.map(withAssetUrls);
}

export async function listCatalog(): Promise<CatalogTemplate[]> {
  const first = await getTemplates({ page: 1, limit: 100 });
  const rest = await Promise.all(
    Array.from(
      { length: Math.max(0, first.pagination.totalPages - 1) },
      (_, i) => getTemplates({ page: i + 2, limit: 100 }),
    ),
  );
  return [first, ...rest].flatMap((page) => page.data).map(withAssetUrls);
}

export async function getTemplate(slug: string) {
  const safe = slugSchema.safeParse(slug);
  if (!safe.success) return null;

  const response = await get(
    apiUrl(`/templates/${safe.data}`),
    "application/json",
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Template catalog returned ${response.status}.`);

  return apiTemplateSchema.parse(await response.json());
}

export async function getTemplateVariant(
  templateSlug: string,
  variantSlug: string,
) {
  const template = slugSchema.safeParse(templateSlug);
  const variant = slugSchema.safeParse(variantSlug);
  if (!template.success || !variant.success) return null;

  const family = await getTemplate(template.data);
  if (!family) return null;

  const selected = family.variants.find(({ slug }) => slug === variant.data);
  if (!selected) return null;

  const [compose, config] = await Promise.all([
    fetchText(selected.files.compose, template.data),
    fetchText(selected.files.config, template.data),
  ]);
  return { ...family, variant: selected, compose, config };
}

export async function templateImageBytes(url: string): Promise<Buffer | null> {
  try {
    const response = await get(url, "image/webp", IMAGE_TTL);
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_LOGO_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

export async function templateLogoDataUri(
  path: string | null,
): Promise<string | null> {
  if (!path) return null;
  const bytes = await templateImageBytes(templateAssetUrl(path));
  return bytes ? `data:image/webp;base64,${bytes.toString("base64")}` : null;
}
