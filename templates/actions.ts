"use server";

import { z } from "zod";
import {
  apiCategorySchema,
  apiTemplateSchema,
  categoriesResponseSchema,
  categoryListQuerySchema,
  slugSchema,
  statusResponseSchema,
  templateListQuerySchema,
  templatesResponseSchema,
  versionResponseSchema,
} from "./schema";
import type { CategoryListQuery, TemplateListQuery } from "./types";

const cacheOptions = {
  cache: "force-cache" as const,
  next: { revalidate: 3600, tags: ["templates"] },
};

function apiUrl(path: string) {
  const base = process.env.DEPLO_TEMPLATES_API_URL;
  if (!base) throw new Error("DEPLO_TEMPLATES_API_URL is required.");
  return new URL(path, `${base.replace(/\/+$/, "")}/`).toString();
}

function listUrl<T>(path: string, schema: z.ZodType<T>, input: unknown) {
  const query = schema.parse(input);
  const url = new URL(apiUrl(path));
  for (const [key, value] of Object.entries(query as Record<string, unknown>))
    if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

async function fetchApi<T>(url: string, schema: z.ZodType<T>) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...cacheOptions,
  });
  if (!response.ok)
    throw new Error(`Templates API returned ${response.status}.`);
  return schema.parse(await response.json());
}

async function fetchText(path: string, slug: string) {
  const response = await fetch(apiUrl(templateAssetPathSchema.parse(path)), {
    headers: { Accept: "text/plain" },
    ...cacheOptions,
    next: { revalidate: 3600, tags: ["templates", `template:${slug}`] },
  });
  if (!response.ok)
    throw new Error(`Templates API returned ${response.status}.`);
  return response.text();
}

export async function getTemplates(query: TemplateListQuery = {}) {
  return fetchApi(
    listUrl("/templates", templateListQuerySchema, query),
    templatesResponseSchema,
  );
}

export async function getTemplate(slug: string) {
  const safeSlug = slugSchema.parse(slug);
  const template = await fetchApi(
    apiUrl(`/templates/${safeSlug}`),
    apiTemplateSchema,
  );
  const [compose, config] = await Promise.all([
    fetchText(template.files.compose, safeSlug),
    fetchText(template.files.config, safeSlug),
  ]);
  return { ...template, compose, config };
}

export async function getCategories(query: CategoryListQuery = {}) {
  return fetchApi(
    listUrl("/categories", categoryListQuerySchema, query),
    categoriesResponseSchema,
  );
}

export async function getCategory(slug: string) {
  return fetchApi(
    apiUrl(`/categories/${slugSchema.parse(slug)}`),
    apiCategorySchema,
  );
}

export async function getStatus() {
  return fetchApi(apiUrl("/status"), statusResponseSchema);
}

export async function getVersion() {
  return fetchApi(apiUrl("/version"), versionResponseSchema);
}
