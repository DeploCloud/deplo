import type z from "zod";
import type { apiTemplateSchema, templateListQuerySchema } from "./schema";

export type TemplateListQuery = z.input<typeof templateListQuerySchema>;

/** A catalog entry exactly as the service serves it. */
export type ApiTemplate = z.output<typeof apiTemplateSchema>;

/**
 * A catalog entry as the UI gets it: the whole thing, with the asset paths
 * resolved to absolute URLs. Nothing is trimmed — the catalog carries the
 * author, the links, the screenshots and the dates so the UI can show them.
 */
export type CatalogTemplate = Omit<ApiTemplate, "logo" | "images"> & {
  logo: string | null;
  images: string[];
};
