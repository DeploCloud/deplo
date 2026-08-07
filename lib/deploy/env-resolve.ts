/**
 * The env-gathering rule: which variables reach an app's runtime, and in what
 * order. One target axis (`production | preview`) governs both an
 * app's own vars AND shared vars — a shared var is just an app var that several
 * apps share, so it obeys the same target rule.
 *
 * Pure on purpose: no store, no docker, no `decryptSecret`, no `server-only`.
 * It selects and orders the *encrypted* entries; the deploy callers decrypt
 * at the edge. Keeping selection here (instead of inline in `build.ts`) means
 * every runtime resolves env through the exact same seam — callers can never
 * drift on what a target inherits.
 */

import type { EnvTarget } from "../types";

/** The fields this module reads from an app's own var (an `EnvVar` satisfies it). */
export interface TargetedEnvEntry {
  appId: string;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/**
 * A GLOBAL entry (instance-wide, admin-managed). It carries no `appId` because it
 * applies to every app of every team — only its `targets` gate which runtime sees
 * it. (Team-global vars are no longer a distinct layer: they became team-wide
 * shared vars — ADR-0010.)
 */
export interface GlobalEnvEntryLike {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/**
 * A shared var the app has explicitly opted into (a per-app link — ADR-0012).
 * Availability scopes (team-wide / environment / project) never inject by
 * themselves, so the loader only ever hands this module linked entries.
 */
export interface SharedVarEntry {
  key: string;
  valueEnc: string;
  /** Orthogonal runtime axis; the loader defaults an empty set to every target. */
  targets: EnvTarget[];
  /** `plain` | `secret`. Read only by the caller that drops secrets from a fork
   *  preview's env — the selection here is target-based and ignores it. */
  type?: string;
}

/**
 * A PREVIEW-ONLY override of one key (ADR-0014). Unlike every layer above it,
 * this one carries no target axis: the table exists solely for the `preview`
 * runtime, so a row IS its target.
 */
export interface PreviewOverrideEntry {
  key: string;
  valueEnc: string;
}

/**
 * The ordered, still-encrypted env entries an app inherits for one runtime.
 * Entries are emitted LOWEST precedence first; the callers fold them into an
 * object so a later entry wins on a key collision. The order is:
 *
 *   instance-global  →  app's own var  →  opted-in (linked) shared var
 *   →  preview-only override  (the `preview` runtime only)
 *
 * Shared variables are strictly OPT-IN per app (ADR-0012): a var reaches an app
 * only through its explicit per-app link, never through a team-wide / environment
 * / project scope — those scopes only say who MAY opt in. The link keeps the top
 * slot it has held since the shared-groups era (ADR-0010 §4): an explicit
 * attachment overrides the app's own value on a key collision.
 *
 * A PREVIEW OVERRIDE outranks even that, and only in the `preview` runtime
 * (ADR-0014). The reason is the same one that gives the per-app link the slot
 * above the app's own var, applied once more: a shared variable is a TEAM
 * default, while an override is the most specific statement a user can make
 * ("in previews, use this"). If a team-wide value outranked it, the feature
 * could not do the one thing it exists for — pointing a pull request's preview
 * at a scratch database instead of the production one.
 *
 * Same-key collisions WITHIN the shared layer (two linked vars sharing a key)
 * are broken by input order — the loader supplies shared vars sorted by
 * `created_at ASC`, so the later-created one wins on the fold.
 */
export function resolveEnvEntries(
  target: EnvTarget,
  appId: string,
  envVars: TargetedEnvEntry[],
  sharedVars: SharedVarEntry[],
  instanceGlobals: GlobalEnvEntryLike[] = [],
  previewOverrides: PreviewOverrideEntry[] = [],
): { key: string; valueEnc: string }[] {
  const out: { key: string; valueEnc: string }[] = [];
  for (const e of instanceGlobals) {
    if (e.targets.includes(target)) out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  for (const e of envVars) {
    if (e.appId === appId && e.targets.includes(target)) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  for (const e of sharedVars) {
    if (e.targets.includes(target)) out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  // Defaulted to `[]`, so every production caller is byte-identical.
  if (target === "preview") {
    for (const e of previewOverrides) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  return out;
}
