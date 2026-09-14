import type z from "zod";
import type {
  apiTemplateSchema,
  apiTemplateVariantSchema,
  templateListQuerySchema,
} from "./schema";

export type TemplateListQuery = z.input<typeof templateListQuerySchema>;

// ApiTemplate is a catalog entry exactly as the service serves it.
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

// CatalogTemplateVariant is a catalog entry as the UI gets it, asset paths resolved to absolute URLs.
export type CatalogTemplateVariant = Omit<
  ApiTemplateVariant,
  "logo" | "images"
> & {
  logo: string | null;
  images: string[];
};

export type CatalogTemplate = Omit<ApiTemplate, "logo" | "variants"> & {
  logo: string | null;
  variants: CatalogTemplateVariant[];
};
