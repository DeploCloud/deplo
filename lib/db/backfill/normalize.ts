import {
  ALL_CAPABILITIES,
  ALL_ENV_TARGETS,
  type Capability,
  type EnvTarget,
  type FrameworkId,
  type Role,
} from "../../types";
import { capabilitiesForRole } from "../../membership-shared";
import { defaultBuildMethod } from "../../frameworks";

/**
 * Shared normalize / coerce helpers for the backfill engine (relational-store
 * PLAN §7 "Fidelity: normalize BEFORE exploding into strict child tables" +
 * "Coerce legacy enum-ish values, don't reject").
 *
 * Store rows are NEVER rewritten today — projects are normalized only on READ, so
 * the stored shape stays legacy. A raw legacy row would therefore violate the new
 * strict child-table NOT-NULL columns, and the un-validated write paths (framework
 * passed `as never`, unknown `buildMethod`, persisted `imageKind`) would land
 * values no `pgEnum` accepts. The rule everywhere is **coerce, never reject** —
 * which is also why §1 keeps `framework`/`build_method` as plain text (no CHECK)
 * and the dev/github enums coerce unknowns to a safe member.
 *
 * These functions are PURE and store-free (they import only the pure helpers
 * `capabilitiesForRole` / `defaultBuildMethod` and the canonical lists), so the
 * engine never drags in the `lib/data/*` request-context graph. The per-cut-set
 * copies (Steps 2–5) call them before exploding a collection into its tables.
 */

/* ------------------------------------------------------------------ */
/* Capabilities / env targets                                          */
/* ------------------------------------------------------------------ */

/**
 * Sanitize an arbitrary capability list to known values, always implying `view`,
 * returned in canonical `ALL_CAPABILITIES` order. Mirrors the private
 * `cleanCapabilities` in [lib/data/members.ts](../../data/members.ts#L90) — the
 * membership-capability junction guard the PLAN §7 names.
 */
export function cleanCapabilities(
  caps: Capability[] | undefined,
  role: Role,
): Capability[] {
  const base = caps?.length ? caps : capabilitiesForRole(role);
  const set = new Set(base.filter((c) => ALL_CAPABILITIES.includes(c)));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/**
 * Sanitize an env-target list to the known set, defaulting to all three when
 * empty. Mirrors the private `sanitizeTargets` in
 * [lib/data/shared-env.ts](../../data/shared-env.ts#L109) — guards the
 * `env_var_targets` / `shared_env_group_targets` junctions.
 */
export function sanitizeTargets(targets: EnvTarget[] | undefined): EnvTarget[] {
  const list = targets ?? [];
  const kept = ALL_ENV_TARGETS.filter((t) => list.includes(t));
  return kept.length ? kept : [...ALL_ENV_TARGETS];
}

/* ------------------------------------------------------------------ */
/* Enum-ish coercions (PLAN §7 "Coerce legacy enum-ish values")        */
/* ------------------------------------------------------------------ */

/** Every valid {@link FrameworkId} (the closed UI list), for membership tests. */
const FRAMEWORK_IDS: ReadonlySet<string> = new Set<FrameworkId>([
  "nextjs",
  "svelte",
  "sveltekit",
  "astro",
  "vite",
  "remix",
  "nuxt",
  "react",
  "vue",
  "angular",
  "gatsby",
  "static",
  "node",
  "python",
  "go",
  "rust",
  "php",
  "docker",
  "other",
]);

/**
 * Coerce an unknown/missing framework to `'other'`. MUST run before
 * `buildConfigFor`/`normalizeBuildConfig`, which index `FRAMEWORKS[framework]`
 * with no fallback and throw on an unknown id (PLAN §7).
 */
export function coerceFramework(framework: string | undefined): FrameworkId {
  return framework && FRAMEWORK_IDS.has(framework)
    ? (framework as FrameworkId)
    : "other";
}

/**
 * Coerce a build method to a known one, falling back to the framework default
 * (`defaultBuildMethod`: docker→dockerfile, static→static, else nixpacks). The
 * `build_method` column is plain text (no CHECK) to hold whatever this returns.
 */
export function coerceBuildMethod(
  buildMethod: string | undefined,
  framework: FrameworkId,
): string {
  const known = new Set([
    "dockerfile",
    "railpack",
    "nixpacks",
    "heroku",
    "paketo",
    "static",
  ]);
  return buildMethod && known.has(buildMethod)
    ? buildMethod
    : defaultBuildMethod(framework);
}

/** Coerce a dev image-kind to `'preset'` when unknown/missing (PLAN §7). */
export function coerceImageKind(imageKind: string | undefined): string {
  return imageKind === "custom" ? "custom" : "preset";
}

/** Coerce a dev status to a valid `dev_status` enum member; unknown → `'off'`. */
export function coerceDevStatus(status: string | undefined): string {
  const known = new Set(["off", "starting", "running", "stopped", "error"]);
  return status && known.has(status) ? status : "off";
}

/** Coerce a GitHub account type to a `github_account_type` enum member. */
export function coerceGithubAccountType(accountType: string | undefined): string {
  return accountType === "Organization" ? "Organization" : "User";
}
