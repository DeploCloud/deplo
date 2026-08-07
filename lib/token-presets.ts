import { ALL_CAPABILITIES, type Capability } from "./types";

/**
 * The shipped templates a new API token can start from.
 *
 * A token's permission set is mandatory, and forty checkboxes is not a first
 * decision anyone should have to make. These five answer "what is this token
 * for" instead, and every one of them is a starting point: whatever you pick,
 * the picker opens on the next step with every box editable.
 *
 * They are NOT rows and are NOT editable — unlike a Role, which a team owns and
 * can rename or reset. A template that drifts per team stops being something we
 * can reason about, and "start from an existing token" would mean reading one
 * credential's power to author another. So: our templates, or from scratch.
 *
 * Icons live with the component that renders them (`TOKEN_PRESET_ICON`), the
 * same split as `lib/apps/framework-catalog.ts` vs `components/shared/
 * framework-icons.tsx` — no `lib/` module in this repo imports lucide-react.
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
    // Deliberately the same four the Viewer role grants: "Read only" for a token
    // and "Viewer" for a person should mean the same thing, or one of the two
    // words is lying. `read_app_files` is NOT read-only in the sense that
    // matters — an app's storage directory is where .env files, keys and certs
    // live — and Viewer excludes it for exactly that reason.
    capabilities: ["view", "view_logs", "view_metrics", "view_activity"],
  },
  {
    id: "ci",
    name: "Deploy hook & CI",
    description:
      "Ships apps that are already set up. What a deploy hook or a CI job needs.",
    // `deploy_apps` is precisely what redeploy gates on, so a deploy hook works
    // with nothing else. `view_logs` because the universal CI shape is "trigger,
    // then tail the build log to decide whether the pipeline passed" — without
    // it the job starts a deploy whose outcome it can never learn.
    //
    // `configure_apps` is the one to understand: a leaked CI token that can
    // repoint the app's deploy source at an attacker's repository and then
    // deploy it is remote code execution. The split of deploy_apps from
    // configure_apps exists so this token cannot. Also out: create_apps (CI does
    // not invent apps), control_apps (stopping production is not shipping),
    // manage_env / reveal_secrets (CI carries its own secrets; a token that can
    // read production's is strictly worse than one that cannot).
    capabilities: ["view", "deploy_apps", "view_logs"],
  },
  {
    id: "mcp",
    name: "MCP & AI agents",
    description:
      "Lets an assistant read the team and restart or redeploy an app, with nothing that can leak a secret or destroy data.",
    // The rule: an agent may look at anything and may bounce a service; it may
    // not read a secret, run arbitrary code, or destroy anything. Everything
    // excluded falls into one of four buckets.
    //
    //  1. Leaks a secret into a third party's context window — reveal_secrets
    //     (decrypts straight into a prompt), manage_env (write, redeploy, read
    //     back is an exfiltration loop wearing a config change's name),
    //     read_app_files (.env, certificates, service-account JSON).
    //  2. Is arbitrary code execution under another name — open_app_console and
    //     open_database_console (a shell is every capability at once, and no
    //     list can bound what a model does once inside one), manage_crons (the
    //     same shell, on a timer, still running long after the conversation
    //     ended), write_app_files and configure_apps (both become execution on
    //     the next deploy).
    //  3. Destroys with no undo on a hallucinated id — every delete_*, and
    //     restore_backups, which overwrites live data and is meant to need a
    //     typed human confirmation, not one emitted JSON field.
    //  4. Escapes the token's own boundary — manage_tokens (a token that mints
    //     tokens is unbounded by construction), move_apps (its own description
    //     says "or another team"), manage_members and manage_roles.
    //
    // What is left is the honest useful half: read everything, then restart or
    // redeploy — the on-call motion that actually pays for an agent, and both
    // are undone by repeating them.
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
    // This preset exists to keep people off Root. Someone standing an app up
    // from a script needs create + configure + env + domain + deploy; if the
    // only template that covers that is Root access, they pick Root and never
    // look again.
    //
    // Out: reveal_secrets (write-only env is deplo's own model), every delete_*
    // (a bad loop deletes production; deletion is the thing you tick by hand),
    // open_app_console, restore_backups, move_apps, and all team
    // administration. create_projects and manage_environments are out too — a
    // Project is an organisational decision a human makes once, not something a
    // deploy script invents per run.
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
    // Spread, not a literal list, so a capability added tomorrow joins it for
    // free. It exists for two reasons: it is what every token already WAS before
    // this feature, so the upgrade has a name; and someone who genuinely wants
    // it should reach it in one click rather than tick forty boxes and mis-tick
    // one. Whoever creates it still cannot exceed their own capabilities.
    capabilities: [...ALL_CAPABILITIES],
  },
];

export function tokenPreset(id: string): TokenPreset | null {
  return TOKEN_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The template a capability set matches EXACTLY, or null for a hand-picked set.
 * Lets the token list say "Deploy hook & CI" instead of "3 permissions". The
 * mirror of `roleLabelForCapabilities` in `lib/membership-shared.ts`, and honest
 * only because a test pins every template's set to be unique.
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
