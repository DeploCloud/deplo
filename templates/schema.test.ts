import { test } from "node:test";
import assert from "node:assert/strict";

import { apiTemplateVariantSchema } from "./schema";

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
