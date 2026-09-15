export interface TemplateCollection {
  title: string;
  subtitle: string;
  slugs: string[];
}

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

export const FEATURED = [
  "uptime-kuma",
  "n8n",
  "vaultwarden",
  "immich",
  "nextcloud",
  "plausible",
  "portainer",
];
