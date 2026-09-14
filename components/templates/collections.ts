// TemplateCollection - the catalog has no popularity signal and no dates, so a row is editorial; slugs are matched at render, so a rename costs a card, never the page.
export interface TemplateCollection {
  title: string;
  subtitle: string;
  slugs: string[];
}

// Below this a row looks broken rather than curated, so it is hidden.
export const MIN_COLLECTION_SIZE = 4;

export const COLLECTIONS: TemplateCollection[] = [
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

// FEATURED - the first is the hero, the other six fill the columns beside it; all are dropped from the collections above so no card appears twice on one screen.
export const FEATURED = [
  "uptime-kuma",
  "n8n",
  "vaultwarden",
  "immich",
  "nextcloud",
  "plausible",
  "portainer",
];
