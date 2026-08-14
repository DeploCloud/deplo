/**
 * The shapes the template catalog service serves. Remote input: everything the
 * client in `./catalog.ts` reads is parsed through here before it is used.
 */
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
    sort: z.enum(["name", "category", "createdAt", "lastUpdate"]).default("name"),
  })
  .strict();

const httpsUrlSchema = z
  .url()
  .max(2048)
  .refine((url) => url.startsWith("https://"));

const apiLinkSchema = z
  .object({
    label: z.string().min(2).max(80),
    url: httpsUrlSchema,
  })
  .strict();

const apiCategorySchema = z
  .object({
    name: z.string().min(2).max(48),
    icon: z.string().min(3).max(64),
    description: z.string().min(20).max(400),
    slug: slugSchema,
  })
  .strict();

const apiTemplateLinksSchema = z
  .object({
    github: httpsUrlSchema.optional(),
    website: httpsUrlSchema.optional(),
    docs: httpsUrlSchema.optional(),
  })
  .strict()
  .refine((links) => Object.values(links).some(Boolean));

const apiTemplateFilesSchema = z
  .object({
    config: z
      .string()
      .regex(/^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/template\.toml$/),
    compose: z
      .string()
      .regex(/^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/docker-compose\.yml$/),
  })
  .strict();

export const apiTemplateSchema = z
  .object({
    name: z.string().min(2).max(80),
    shortDescription: z.string().min(20).max(240),

    category: apiCategorySchema,

    developedBy: apiLinkSchema,
    submittedBy: apiLinkSchema,
    links: apiTemplateLinksSchema,

    lastUpdate: z.iso.datetime(),
    createdAt: z.iso.datetime(),

    description: z.string().min(20).max(20_000),
    slug: slugSchema,

    logo: z
      .string()
      .regex(/^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/logo\.webp$/)
      .nullable(),

    images: z.array(
      z.string().regex(/^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9]\d*\.webp$/),
    ),

    files: apiTemplateFilesSchema,
  })
  .strict();

const paginationSchema = z
  .object({
    page: z.number().int().positive(),
    limit: z.number().int().positive().max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();

export const templatesResponseSchema = z
  .object({
    data: z.array(apiTemplateSchema),
    pagination: paginationSchema,
  })
  .strict();

export const templateAssetPathSchema = z.union([
  z
    .string()
    .regex(/^\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:logo|[1-9]\d*)\.webp$/),
  z
    .string()
    .regex(
      /^\/files\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:template\.toml|docker-compose\.yml)$/,
    ),
]);
