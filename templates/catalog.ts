import "server-only";

// https://deplo.build/docs/guides/deploy/from-template

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

/**
 * Client for the one-click template catalog (the `DeploCloud/templates` service).
 * Every response is validated against `./schema` before it is used: this is remote
 * input, and its variant files end up in a deploy.
 */

const cacheOptions = {
  cache: "force-cache" as const,
  next: { revalidate: 3600, tags: ["templates"] },
} satisfies RequestInit;

function apiUrl(path: string): string {
  return `${templatesApiBase()}${path}`;
}

/**
 * Absolute URL for a catalog asset (a logo, a screenshot, a blueprint file).
 * The path always comes from the API's own response and is re-validated here,
 * so a compromised catalog cannot point the browser at an arbitrary URL.
 */
export function templateAssetUrl(path: string): string {
  return apiUrl(templateAssetPathSchema.parse(path));
}

async function get(url: string, accept: string, tags?: string[]) {
  const response = await fetch(url, {
    headers: { Accept: accept },
    ...cacheOptions,
    ...(tags ? { next: { revalidate: 3600, tags } } : {}),
  });
  return response;
}

async function fetchJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await get(apiUrl(path), "application/json");
  if (!response.ok)
    throw new Error(`Template catalog returned ${response.status}.`);
  return schema.parse(await response.json());
}

async function fetchText(path: string, slug: string): Promise<string> {
  const response = await get(templateAssetUrl(path), "text/plain", [
    "templates",
    `template:${slug}`,
  ]);
  if (!response.ok)
    throw new Error(`Template catalog returned ${response.status}.`);
  return response.text();
}

/** One page of the catalog. */
export async function getTemplates(query: TemplateListQuery = {}) {
  const parsed = templateListQuerySchema.parse(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed))
    if (value !== undefined) params.set(key, String(value));
  return fetchJson(`/templates?${params}`, templatesResponseSchema);
}

/** The same entry, with every asset path turned into an absolute URL. */
function withAssetUrls(t: ApiTemplate): CatalogTemplate {
  return {
    ...t,
    logo: t.logo ? templateAssetUrl(t.logo) : null,
    variants: t.variants.map((variant) => ({
      ...variant,
      logo: templateAssetUrl(variant.logo),
      images: variant.images.map(templateAssetUrl),
    })),
  };
}

/**
 * The whole catalog, every field the service serves.
 */
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

/** `null` when the slug is unknown; this call never selects a variant. */
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

/**
 * A deployable template family plus exactly the requested variant's files.
 * `null` means either slug is invalid, the family is unknown, or the variant
 * is not part of that family.
 */
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

/**
 * The raw bytes of a catalog image, from the same hour-long cache every other
 * request uses.
 */
export async function templateImageBytes(url: string): Promise<Buffer | null> {
  try {
    const response = await get(url, "image/webp");
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_LOGO_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A template's logo inlined as a data URI.
 */
export async function templateLogoDataUri(
  path: string | null,
): Promise<string | null> {
  if (!path) return null;
  const bytes = await templateImageBytes(templateAssetUrl(path));
  return bytes ? `data:image/webp;base64,${bytes.toString("base64")}` : null;
}
