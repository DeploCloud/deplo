import { test } from "node:test";
import assert from "node:assert/strict";

import { apiTemplateVariantSchema, templatesResponseSchema } from "./schema";

const variant = {
  name: "Ghost",
  shortDescription: "A publishing platform for a professional blog.",
  category: {
    name: "CMS",
    icon: "newspaper",
    description: "Publish a site without writing the plumbing yourself.",
    slug: "cms",
  },
  developedBy: { label: "Ghost", url: "https://ghost.org" },
  submittedBy: { label: "Deplo", url: "https://deplo.build" },
  links: { website: "https://ghost.org" },
  lastUpdate: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  description: "A publishing platform for a professional blog.",
  slug: "default",
  logo: "/images/ghost/default/logo.webp",
  images: [],
  files: {
    config: "/files/ghost/default/template.toml",
    compose: "/files/ghost/default/docker-compose.yml",
  },
};

test("a catalog entry with no alerts still parses", () => {
  assert.deepEqual(apiTemplateVariantSchema.parse(variant).alerts, []);
});

test("an alert links over https or not at all", () => {
  const alert = { type: "warning", message: "Set a password on first boot." };
  assert.equal(
    apiTemplateVariantSchema.parse({ ...variant, alerts: [alert] }).alerts
      .length,
    1,
  );
  for (const link of ["http://ghost.org", "javascript:alert(1)"])
    assert.equal(
      apiTemplateVariantSchema.safeParse({
        ...variant,
        alerts: [{ ...alert, link }],
      }).success,
      false,
    );
});

test("catalog responses ignore new fields without changing known data", () => {
  const entry = {
    name: "Ghost",
    slug: "ghost",
    logo: null,
    variants: [variant],
  };
  const pagination = { page: 1, limit: 20, total: 1, totalPages: 1 };
  const response = { data: [entry], pagination };
  assert.deepEqual(
    templatesResponseSchema.parse({
      ...response,
      version: "new",
      pagination: { ...pagination, cursor: "next" },
      data: [
        {
          ...entry,
          featured: true,
          variants: [
            {
              ...variant,
              downloadCount: 15,
              category: { ...variant.category, color: "blue" },
              developedBy: { ...variant.developedBy, avatar: "new" },
              links: { ...variant.links, support: "https://example.com" },
              files: { ...variant.files, readme: "new" },
            },
          ],
        },
      ],
    }),
    templatesResponseSchema.parse(response),
  );
});

test("a logo's accent is read when sound and dropped when not", () => {
  const accent = (value?: unknown) =>
    apiTemplateVariantSchema.parse(
      value === undefined ? variant : { ...variant, accent: value },
    ).accent;
  assert.deepEqual(accent({ hue: 212 }), { hue: 212 });
  assert.deepEqual(accent({ tone: "dark" }), { tone: "dark" });
  for (const unsound of [
    undefined,
    null,
    { hue: 400 },
    { tone: "red" },
    "blue",
  ])
    assert.equal(accent(unsound), null);
});
