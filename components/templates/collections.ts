// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The store's editorial rows. The catalog has no popularity signal and no dates,
 * so "Most installed" would be an arbitrary order wearing a confident label.
 * Slugs are matched at render time, so a rename costs a card, never the page. */
export interface TemplateCollection {
  title: string;
  subtitle: string;
  slugs: string[];
}

/** Below this a row looks broken rather than curated, so it is hidden. */
export const MIN_COLLECTION_SIZE = 4;

export const COLLECTIONS: TemplateCollection[] = [
  {
    title: "Start here",
    subtitle: "The ones everyone deploys first",
    slugs: [
      "uptime-kuma",
      "vaultwarden",
      "n8n",
      "nextcloud",
      "portainer",
      "dozzle",
      "memos",
      "plausible",
    ],
  },
  {
    title: "Serving hot now",
    subtitle: "What teams are putting on their own servers",
    slugs: [
      "affine-pro",
      "authentik",
      "immich",
      "outline",
      "docmost",
      "umami",
      "twenty-crm",
      "plane",
    ],
  },
  {
    title: "Run your own AI",
    subtitle: "Local models, chat and RAG on your own hardware",
    slugs: [
      "open-webui",
      "anythingllm",
      "librechat",
      "lobe-chat",
      "litellm",
      "flowise",
      "langflow",
      "open-notebook",
    ],
  },
  {
    title: "Be your own bank",
    subtitle: "Budgets, invoices and books you host yourself",
    slugs: [
      "actual-budget",
      "wallos",
      "invoiceshelf",
      "akaunting",
      "ezbookkeeping",
      "kimai",
      "maybe",
      "dumbbudget",
    ],
  },
];
