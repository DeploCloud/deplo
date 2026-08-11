"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { z } from "zod";
import {
  apiCategorySchema,
  apiTemplateSchema,
  categoriesResponseSchema,
  categoryListQuerySchema,
  slugSchema,
  statusResponseSchema,
  templateAssetPathSchema,
  templateListQuerySchema,
  templatesResponseSchema,
  versionResponseSchema,
} from "./schema";
import { CategoryListQuery, TemplateListQuery } from "./types";

const swrOptions = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  shouldRetryOnError: true,
  errorRetryCount: 2,
} satisfies SWRConfiguration;

function apiUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_DEPLO_TEMPLATES_API_URL;
  if (!base)
    throw new Error("NEXT_PUBLIC_DEPLO_TEMPLATES_API_URL is required.");
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
  });
  if (!response.ok)
    throw new Error(`Templates API returned ${response.status}.`);
  return schema.parse(await response.json());
}

function useApi<T>(
  key: string | null,
  schema: z.ZodType<T>,
  options?: SWRConfiguration,
) {
  return useSWR<T, Error>(key, (url: string) => fetchApi(url, schema), {
    ...swrOptions,
    ...options,
  });
}

export function useTemplates(query: TemplateListQuery = {}) {
  return useApi(
    listUrl("/templates", templateListQuerySchema, query),
    templatesResponseSchema,
    { keepPreviousData: true },
  );
}

export function useTemplate(slug?: string | null) {
  return useApi(
    slug ? apiUrl(`/templates/${slugSchema.parse(slug)}`) : null,
    apiTemplateSchema,
  );
}

export function useCategories(query: CategoryListQuery = {}) {
  return useApi(
    listUrl("/categories", categoryListQuerySchema, query),
    categoriesResponseSchema,
    { keepPreviousData: true },
  );
}

export function useCategory(slug?: string | null) {
  return useApi(
    slug ? apiUrl(`/categories/${slugSchema.parse(slug)}`) : null,
    apiCategorySchema,
  );
}

export function useStatus() {
  return useApi(apiUrl("/status"), statusResponseSchema);
}

export function useVersion() {
  return useApi(apiUrl("/version"), versionResponseSchema);
}

export function templateAssetUrl(path: string) {
  return apiUrl(templateAssetPathSchema.parse(path));
}
