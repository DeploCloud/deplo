/**
 * The store's editorial rows.
 *
 * The catalog service has no popularity signal and no per-template dates — all
 * 388 entries carry the same `createdAt` and `lastUpdate` — so a "Most
 * installed" or "New arrivals" row would be an arbitrary order wearing a
 * confident label. These rows are curated here instead, which is honest about
 * what they are: a recommendation, not a measurement.
 *
 * Slugs are matched against the live catalogue at render time. An unknown one
 * is dropped silently and a row left with too few entries does not render at
 * all, so a template renamed upstream costs a card, never the page.
 */
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
