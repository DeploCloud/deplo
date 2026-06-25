/**
 * The env-gathering rule: which variables reach a project's runtime, and in
 * what order. One target axis (`production | preview | development`) governs
 * both per-project vars AND shared groups — a shared group is just project vars
 * that several projects share, so it obeys the same target rule.
 *
 * Pure on purpose: no store, no docker, no `decryptSecret`, no `server-only`.
 * It selects and orders the *encrypted* entries; the deploy/dev callers decrypt
 * at the edge. Keeping selection here (instead of inline in `build.ts` and
 * `dev.ts`) means the production stack and the dev container resolve env through
 * the exact same seam — they can never drift on what a target inherits.
 */

import { ALL_ENV_TARGETS } from "../types";
import type { EnvTarget } from "../types";

/** The fields this module reads from a per-project var (an `EnvVar` satisfies it). */
export interface TargetedEnvEntry {
  projectId: string;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/** The fields this module reads from a shared group (a `SharedEnvGroup` satisfies it). */
export interface SharedEnvGroupLike {
  projectIds: string[];
  /** Legacy groups persisted before the target axis have this undefined. */
  targets?: EnvTarget[];
  variables: { key: string; valueEnc: string }[];
}

/**
 * A GLOBAL entry (team-wide or instance-wide). It carries no `projectId` because
 * it applies to every project — only its `targets` gate which runtime sees it.
 */
export interface GlobalEnvEntryLike {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/**
 * A group's targets, defaulting legacy records (no `targets` field) to all
 * three. Older groups reached only production; treating them as all-targets
 * preserves that production injection while letting the user opt them out by
 * editing — it never silently drops a variable.
 */
export function groupTargets(g: SharedEnvGroupLike): EnvTarget[] {
  return g.targets?.length ? g.targets : ALL_ENV_TARGETS;
}

/**
 * The ordered, still-encrypted env entries a project inherits for one runtime.
 * Entries are emitted LOWEST precedence first; the callers fold them into an
 * object so a later entry wins on a key collision. The order — broadest default
 * to most specific — is:
 *
 *   instance-global  →  team-global  →  project's own  →  attached shared group
 *
 * So an all-teams default is overridable by a team default, which a project can
 * override, and a shared group still overrides everything (its prior behaviour).
 * The two global layers carry no projectId (they apply to every project); only
 * their `targets` gate the runtime. Both default to empty so existing callers
 * that pass only project + shared keep the old two-layer behaviour.
 */
export function resolveEnvEntries(
  target: EnvTarget,
  projectId: string,
  envVars: TargetedEnvEntry[],
  sharedGroups: SharedEnvGroupLike[],
  teamGlobals: GlobalEnvEntryLike[] = [],
  instanceGlobals: GlobalEnvEntryLike[] = [],
): { key: string; valueEnc: string }[] {
  const out: { key: string; valueEnc: string }[] = [];
  for (const e of instanceGlobals) {
    if (e.targets.includes(target)) out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  for (const e of teamGlobals) {
    if (e.targets.includes(target)) out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  for (const e of envVars) {
    if (e.projectId === projectId && e.targets.includes(target)) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  for (const g of sharedGroups) {
    if (g.projectIds.includes(projectId) && groupTargets(g).includes(target)) {
      for (const v of g.variables) out.push({ key: v.key, valueEnc: v.valueEnc });
    }
  }
  return out;
}
