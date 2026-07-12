/**
 * The env-gathering rule: which variables reach an app's runtime, and in what
 * order. One target axis (`production | preview | development`) governs both an
 * app's own vars AND shared vars — a shared var is just an app var that several
 * apps share, so it obeys the same target rule.
 *
 * Pure on purpose: no store, no docker, no `decryptSecret`, no `server-only`.
 * It selects and orders the *encrypted* entries; the deploy/dev callers decrypt
 * at the edge. Keeping selection here (instead of inline in `build.ts` and
 * `dev.ts`) means the production stack and the dev container resolve env through
 * the exact same seam — they can never drift on what a target inherits.
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
 * The layer a shared var reaches an app through, which also fixes its deploy
 * precedence. A single shared var can match an app several ways (e.g. team-wide
 * AND per-app link); the loader emits one entry per matched layer, so the most
 * specific layer wins the fold. See {@link resolveEnvEntries}.
 */
export type SharedVarMode = "teamWide" | "environment" | "project" | "link";

/** The fields this module reads from a resolved shared var (ADR-0010). */
export interface SharedVarEntry {
  key: string;
  valueEnc: string;
  /** Orthogonal runtime axis; the loader defaults an empty set to all three. */
  targets: EnvTarget[];
  mode: SharedVarMode;
}

/**
 * The ordered, still-encrypted env entries an app inherits for one runtime.
 * Entries are emitted LOWEST precedence first; the callers fold them into an
 * object so a later entry wins on a key collision. The order — broadest default
 * to most specific — is:
 *
 *   instance-global  →  team-wide shared  →  environment shared  →
 *   app's own var  →  project-whitelist shared  →  per-app-link shared
 *
 * This preserves every migrated system's old slot (ADR-0010): a team-global (now
 * team-wide) and an environment var still sit BELOW the app's own var, and a
 * shared group (now a per-app link) still sits ABOVE it. `project` whitelist is
 * new; it sits just below the app's own var so an app's explicit value beats a
 * project default.
 *
 * Same-key collisions WITHIN one shared layer (e.g. two team-wide vars sharing a
 * key) are broken by input order — the loader supplies shared vars sorted by
 * `created_at ASC`, so the later-created one wins on the fold.
 */
export function resolveEnvEntries(
  target: EnvTarget,
  appId: string,
  envVars: TargetedEnvEntry[],
  sharedVars: SharedVarEntry[],
  instanceGlobals: GlobalEnvEntryLike[] = [],
): { key: string; valueEnc: string }[] {
  const out: { key: string; valueEnc: string }[] = [];
  const emitShared = (mode: SharedVarMode) => {
    for (const e of sharedVars) {
      if (e.mode === mode && e.targets.includes(target))
        out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  };
  for (const e of instanceGlobals) {
    if (e.targets.includes(target)) out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  emitShared("teamWide");
  emitShared("environment");
  for (const e of envVars) {
    if (e.appId === appId && e.targets.includes(target)) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  emitShared("project");
  emitShared("link");
  return out;
}
