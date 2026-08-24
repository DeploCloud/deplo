import type z from "zod";
import type {
  apiTemplateSchema,
  apiTemplateVariantSchema,
  templateListQuerySchema,
} from "./schema";

export type TemplateListQuery = z.input<typeof templateListQuerySchema>;

/** A catalog entry exactly as the service serves it. */
export type ApiTemplate = z.output<typeof apiTemplateSchema>;
export type ApiTemplateVariant = z.output<typeof apiTemplateVariantSchema>;

export const DEFAULT_VARIANT_SLUG = "default";

export function defaultVariant(template: {
  slug?: string;
  variants: readonly ApiTemplateVariant[];
}) {
  const variant = template.variants.find(
    ({ slug }) => slug === DEFAULT_VARIANT_SLUG,
  );
  if (!variant)
    throw new Error(`Template ${template.slug ?? ""} has no default variant.`);
  return variant;
}

/**
 * A catalog entry as the UI gets it: the whole thing, with the asset paths
 * resolved to absolute URLs. Nothing is trimmed — the catalog carries the
 * author, the links, the screenshots and the dates so the UI can show them.
 */
export type CatalogTemplateVariant = Omit<
  ApiTemplateVariant,
  "logo" | "images"
> & {
  logo: string;
  images: string[];
};

export type CatalogTemplate = Omit<ApiTemplate, "logo" | "variants"> & {
  logo: string | null;
  variants: CatalogTemplateVariant[];
};
