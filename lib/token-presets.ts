// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { ALL_CAPABILITIES, type Capability } from "./types";

/**
 * The shipped templates a new API token can start from. A token's permission set
 * is mandatory, and forty checkboxes is not a first decision anyone should have to
 * make.
 */
export type TokenPresetId = "readonly" | "ci" | "mcp" | "automation" | "root";

export interface TokenPreset {
  id: TokenPresetId;
  name: string;
  /** One line, shown under the name in the chooser. */
  description: string;
  /** In `ALL_CAPABILITIES` order, always including the `view` floor. */
  capabilities: Capability[];
}

/**
 * Display order in the "New token" menu: least powerful first, so Root access is
 * the deliberate scroll to the bottom rather than the thing that greets you.
 */
export const TOKEN_PRESETS: TokenPreset[] = [
  {
    id: "readonly",
    name: "Read only",
    description:
      "Reads apps, logs, monitoring and the activity log. Changes nothing.",
    // Deliberately the same four the Viewer role grants: "Read only" for a token and
    // "Viewer" for a person should mean the same thing, or one of the two words is
    // lying.
    capabilities: ["view", "view_logs", "view_metrics", "view_activity"],
  },
  {
    id: "ci",
    name: "Deploy hook & CI",
    description:
      "Ships apps that are already set up. What a deploy hook or a CI job needs.",
    // `deploy_apps` is precisely what redeploy gates on, so a deploy hook works with
    // nothing else. The split of deploy_apps from configure_apps exists so this token
    // cannot.
    capabilities: ["view", "deploy_apps", "view_logs"],
  },
  {
    id: "mcp",
    name: "MCP & AI agents",
    description:
      "Lets an assistant read the team and restart or redeploy an app, with nothing that can leak a secret or destroy data.",
    // The rule: an agent may look at anything and may bounce a service; it may not read
    // a secret, run arbitrary code, or destroy anything.
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
    // This preset exists to keep people off Root. Someone standing an app up from a
    // script needs create + configure + env + domain + deploy; if the only template
    // that covers that is Root access, they pick Root and never look again.
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
    // Spread, not a literal list, so a capability added tomorrow joins it for free.
    // Whoever creates it still cannot exceed their own capabilities.
    capabilities: [...ALL_CAPABILITIES],
  },
];

export function tokenPreset(id: string): TokenPreset | null {
  return TOKEN_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The template a capability set matches EXACTLY, or null for a hand-picked set.
 * The mirror of `roleLabelForCapabilities` in `lib/membership-shared.ts`, and
 * honest only because a test pins every template's set to be unique.
 */
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
