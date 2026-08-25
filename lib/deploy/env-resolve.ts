/**
 * The env-gathering rule: which variables reach an app's runtime, and in what
 * order. It selects and orders the *encrypted* entries; the deploy callers decrypt
 * at the edge.
 */

import type { EnvTarget } from "../types";

/**
 * `plain` or `secret`, carried by EVERY layer and REQUIRED on all of them: a fork
 * preview drops secret-typed values, and a loader that forgets does not compile.
 */
export type EnvEntryType = "plain" | "secret";

/** The fields this module reads from an app's own var (an `EnvVar` satisfies it). */
export interface TargetedEnvEntry {
  appId: string;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

/**
 * A GLOBAL entry (instance-wide, admin-managed). It carries no `appId` because it
 * applies to every app of every team — only its `targets` gate which runtime sees
 * it.
 */
export interface GlobalEnvEntryLike {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
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
  type: EnvEntryType;
}

/**
 * A PREVIEW-ONLY override of one key (ADR-0014). Unlike every layer above it,
 * this one carries no target axis: the table exists solely for the `preview`
 * runtime, so a row IS its target.
 */
export interface PreviewOverrideEntry {
  key: string;
  valueEnc: string;
  type: EnvEntryType;
}

/**
 * The ordered, still-encrypted env entries an app inherits for one runtime.
 * Entries are emitted LOWEST precedence first; the callers fold them into an
 * object so a later entry wins on a key collision.
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
    if (e.targets.includes(target))
      out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  for (const e of envVars) {
    if (e.appId === appId && e.targets.includes(target)) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  for (const e of sharedVars) {
    if (e.targets.includes(target))
      out.push({ key: e.key, valueEnc: e.valueEnc });
  }
  // Defaulted to `[]`, so every production caller is byte-identical.
  if (target === "preview") {
    for (const e of previewOverrides) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  return out;
}
