import { revalidateTag } from "next/cache";
import { assertUser } from "@/lib/auth/current-user";
import { rateLimit } from "@/lib/security";
import { builder } from "../builder";
import { matchesQuery } from "@/lib/match-query";
import {
  createAppFromTemplate,
  type CreateAppFromTemplateInput,
} from "@/lib/data/apps/create";
import { listCatalog } from "@/templates/catalog";
import { AppRef } from "./app/app-object";

interface TemplateVariantSummary {
  templateSlug: string;
  variantSlug: string;
  name: string;
  variantName: string;
  category: string;
  shortDescription: string;
  docsUrl: string | null;
}

const TemplateVariantSummaryRef = builder
  .objectRef<TemplateVariantSummary>("TemplateVariantSummary")
  .implement({
    description:
      "A compact, deployable variant from the public template catalog.",
    fields: (t) => ({
      templateSlug: t.exposeString("templateSlug"),
      variantSlug: t.exposeString("variantSlug"),
      name: t.exposeString("name"),
      variantName: t.exposeString("variantName"),
      category: t.exposeString("category"),
      shortDescription: t.exposeString("shortDescription"),
      docsUrl: t.exposeString("docsUrl", { nullable: true }),
    }),
  });

function flattenTemplateVariants(
  catalog: Awaited<ReturnType<typeof listCatalog>>,
  q?: string,
  category?: string,
): TemplateVariantSummary[] {
  const categorySlug = category?.trim().toLowerCase();
  const query = q?.trim();

  return catalog.flatMap((template) =>
    template.variants
      .filter(
        (variant) => !categorySlug || variant.category.slug === categorySlug,
      )
      .filter(
        (variant) =>
          !query ||
          matchesQuery(
            query,
            template.name,
            template.slug,
            variant.name,
            variant.slug,
            variant.shortDescription,
            variant.category.name,
            variant.category.slug,
          ),
      )
      .map((variant) => ({
        templateSlug: template.slug,
        variantSlug: variant.slug,
        name: template.name,
        variantName: variant.name,
        category: variant.category.name,
        shortDescription: variant.shortDescription,
        docsUrl: variant.links.docs?.[0] ?? null,
      })),
  );
}

const CreateAppFromTemplateInputType = builder.inputType(
  "CreateAppFromTemplateInput",
  {
    fields: (t) => ({
      templateSlug: t.string({
        required: true,
        description: "The catalog template slug from templateVariants.",
      }),
      variantSlug: t.string({
        required: false,
        description: 'The variant slug. Omitted uses the "default" variant.',
      }),
      name: t.string({
        required: false,
        description: "The new App name. Omitted uses the template name.",
      }),
      serverId: t.string({ required: false }),
      projectId: t.string({ required: false }),
      environmentId: t.string({ required: false }),
      folderId: t.string({ required: false }),
      deploy: t.boolean({
        required: false,
        description:
          "Request the first deployment. Defaults to false; a token also needs deploy_apps.",
      }),
    }),
  },
);

builder.queryFields((t) => ({
  templateVariants: t.field({
    type: [TemplateVariantSummaryRef],
    authScopes: { loggedIn: true },
    description:
      "List the compact deployable variants in the public template catalog.",
    args: {
      q: t.arg.string({
        required: false,
        description:
          "Keep variants whose template, variant, category or description matches.",
      }),
      category: t.arg.string({
        required: false,
        description: "Filter by the category slug.",
      }),
    },
    resolve: async (_root, { q, category }) =>
      flattenTemplateVariants(
        await listCatalog(),
        q ?? undefined,
        category ?? undefined,
      ),
  }),
}));

builder.mutationFields((t) => ({
  refreshTemplates: t.boolean({
    authScopes: { loggedIn: true },
    description:
      "Drop the cached template catalog so the next read hits the catalog service.",
    resolve: async () => {
      const { id } = await assertUser();
      const limit = await rateLimit(`refresh-templates:${id}`, {
        limit: 3,
        windowMs: 60_000,
      });
      if (!limit.ok)
        throw new Error(
          `Too many refreshes. Try again in ${limit.retryAfterSec}s.`,
        );
      revalidateTag("templates", { expire: 0 });
      return true;
    },
  }),
  createAppFromTemplate: t.field({
    type: AppRef,
    authScopes: { capability: "create_apps" },
    args: {
      input: t.arg({
        type: CreateAppFromTemplateInputType,
        required: true,
      }),
    },
    resolve: (_root, { input }) =>
      createAppFromTemplate({
        templateSlug: input.templateSlug,
        variantSlug: input.variantSlug ?? undefined,
        name: input.name ?? undefined,
        serverId: input.serverId ?? undefined,
        projectId: input.projectId ?? undefined,
        environmentId: input.environmentId ?? undefined,
        folderId: input.folderId ?? undefined,
        deploy: input.deploy ?? false,
      } satisfies CreateAppFromTemplateInput),
  }),
}));
