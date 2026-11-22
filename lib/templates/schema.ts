import { z } from "zod";

export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const templateListQuerySchema = z
  .object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().positive().max(100).default(20),
    search: z.string().trim().max(200).default(""),
    order: z.enum(["asc", "desc"]).default("asc"),
    category: slugSchema.optional(),
    featured: z.literal(true).optional(),
    sort: z.enum(["name"]).default("name"),
  })
  .strict();

const httpsUrlSchema = z
  .url()
  .max(2048)
  .refine((url) => url.startsWith("https://"));

const apiLinkSchema = z.object({
  label: z.string().min(2).max(80),
  url: httpsUrlSchema,
});

const apiCategorySchema = z.object({
  name: z.string().min(2).max(48),
  icon: z.string().min(3).max(64),
  description: z.string().min(20).max(400),
  slug: slugSchema,
});

const apiTemplateLinksSchema = z
  .object({
    github: httpsUrlSchema.optional(),
    website: httpsUrlSchema.optional(),
    docs: z.array(httpsUrlSchema).optional(),
  })
  .refine((links) => Object.values(links).some(Boolean));

const apiTemplateAlertSchema = z.object({
  type: z.enum(["info", "warning", "destructive"]),
  message: z.string().trim().min(1).max(2_000),
  link: httpsUrlSchema.optional(),
});

const apiTemplateVariantFilesSchema = z.object({
  config: z
    .string()
    .regex(
      /^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/template\.toml$/,
    ),
  compose: z
    .string()
    .regex(
      /^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/docker-compose\.yml$/,
    ),
});

export const apiTemplateVariantSchema = z.object({
  name: z.string().min(2).max(80),
  shortDescription: z.string().min(20).max(240),
  category: apiCategorySchema,
  developedBy: apiLinkSchema,
  submittedBy: apiLinkSchema,
  links: apiTemplateLinksSchema,
  alerts: z.array(apiTemplateAlertSchema).default([]),
  lastUpdate: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  description: z.string().min(20).max(20_000),
  slug: slugSchema,
  logo: z
    .string()
    .regex(
      /^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/logo\.webp$/,
    )
    .nullable(),
  images: z.array(
    z
      .string()
      .regex(
        /^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9]\d*\.webp$/,
      ),
  ),
  files: apiTemplateVariantFilesSchema,
});

export const apiTemplateSchema = z
  .object({
    name: z.string().min(2).max(80),
    slug: slugSchema,
    logo: z
      .string()
      .regex(/^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/logo\.webp$/)
      .nullable(),
    variants: z.array(apiTemplateVariantSchema).min(1),
  })
  .refine(
    ({ variants }) => variants.some(({ slug }) => slug === "default"),
    "A default variant is required.",
  );

const paginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export const templatesResponseSchema = z.object({
  data: z.array(apiTemplateSchema),
  pagination: paginationSchema,
});

export const templateAssetPathSchema = z.union([
  z
    .string()
    .regex(
      /^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:logo|[a-z0-9]+(?:-[a-z0-9]+)*\/logo|[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9]\d*)\.webp$/,
    ),
  z
    .string()
    .regex(
      /^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:template\.toml|docker-compose\.yml)$/,
    ),
]);
