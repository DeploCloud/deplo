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
 * A shared var the app has explicitly opted into (a per-app link — ADR-0012).
 * Availability scopes (team-wide / environment / project) never inject by
 * themselves, so the loader only ever hands this module linked entries.
 */
export interface SharedVarEntry {
  key: string;
  valueEnc: string;
  /** Orthogonal runtime axis; the loader defaults an empty set to all three. */
  targets: EnvTarget[];
}

/**
 * The ordered, still-encrypted env entries an app inherits for one runtime.
 * Entries are emitted LOWEST precedence first; the callers fold them into an
 * object so a later entry wins on a key collision. The order is:
 *
 *   instance-global  →  app's own var  →  opted-in (linked) shared var
 *
 * Shared variables are strictly OPT-IN per app (ADR-0012): a var reaches an app
 * only through its explicit per-app link, never through a team-wide / environment
 * / project scope — those scopes only say who MAY opt in. The link keeps the top
 * slot it has held since the shared-groups era (ADR-0010 §4): an explicit
 * attachment overrides the app's own value on a key collision.
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
  return out;
}
