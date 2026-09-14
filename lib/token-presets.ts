import { ALL_CAPABILITIES, type Capability } from "./types/identity";

// The shipped templates a new API token can start from.
export type TokenPresetId = "readonly" | "ci" | "mcp" | "automation" | "root";

export interface TokenPreset {
  id: TokenPresetId;
  name: string;
  description: string;
  capabilities: Capability[];
}

// Display order in the "New token" menu: least powerful first, so Root access is the scroll to the bottom.
export const TOKEN_PRESETS: TokenPreset[] = [
  {
    id: "readonly",
    name: "Read only",
    description:
      "Reads apps, logs, monitoring and the activity log. Changes nothing.",
    // Deliberately the same four the Viewer role grants: "Read only" for a token and
    // "Viewer" for a person must mean the same thing.
    capabilities: ["view", "view_logs", "view_metrics", "view_activity"],
  },
  {
    id: "ci",
    name: "Deploy hook & CI",
    description:
      "Ships apps that are already set up. What a deploy hook or a CI job needs.",
    capabilities: ["view", "deploy_apps", "view_logs"],
  },
  {
    id: "mcp",
    name: "MCP & AI agents",
    description:
      "Lets an assistant read the team and restart or redeploy an app, with nothing that can leak a secret or destroy data.",
    capabilities: [
      "view",
      "deploy_apps",
      "control_apps",
      "view_logs",
      "view_metrics",
      "view_activity",
    ],
  },
  {
    id: "automation",
    name: "App automation",
    description:
      "Creates apps, sets their variables and domains, and ships them. For scripts that stand an app up end to end.",
    capabilities: [
      "view",
      "create_apps",
      "deploy_apps",
      "control_apps",
      "configure_apps",
      "manage_domains",
      "manage_env",
      "view_logs",
    ],
  },
  {
    id: "root",
    name: "Root access",
    description:
      "Every permission in the team, including members, roles and other tokens.",
    capabilities: [...ALL_CAPABILITIES],
  },
];

export function tokenPreset(id: string): TokenPreset | null {
  return TOKEN_PRESETS.find((p) => p.id === id) ?? null;
}

// The template a capability set matches EXACTLY, or null for a hand-picked set.
export function presetIdFor(caps: Capability[]): TokenPresetId | null {
  const set = new Set(caps);
  return (
    TOKEN_PRESETS.find(
      (p) =>
        p.capabilities.length === set.size &&
        p.capabilities.every((c) => set.has(c)),
    )?.id ?? null
  );
}
