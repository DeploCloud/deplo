import type { EnvTarget } from "../types/env";

// EnvEntryType - required on every layer: a fork preview drops secret-typed values.
export type EnvEntryType = "plain" | "secret";

// TargetedEnvEntry - the fields this module reads from an app's own var.
export interface TargetedEnvEntry {
  appId: string;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

// AutoInjectedEntry - a shared var that injects with no per-app link (ADR-0027).
export interface AutoInjectedEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

// SharedVarEntry - a shared var the app opted into with a per-app link (ADR-0012).
export interface SharedVarEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

// PreviewOverrideEntry - a preview-only override of one key (ADR-0014).
export interface PreviewOverrideEntry {
  key: string;
  valueEnc: string;
  type: EnvEntryType;
}

// resolveEnvEntries - still-encrypted env entries for one runtime, lowest precedence first.
export function resolveEnvEntries(
  target: EnvTarget,
  appId: string,
  envVars: TargetedEnvEntry[],
  sharedVars: SharedVarEntry[],
  autoInjected: AutoInjectedEntry[] = [],
  previewOverrides: PreviewOverrideEntry[] = [],
): { key: string; valueEnc: string }[] {
  const out: { key: string; valueEnc: string }[] = [];
  for (const e of autoInjected) {
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
  if (target === "preview") {
    for (const e of previewOverrides) {
      out.push({ key: e.key, valueEnc: e.valueEnc });
    }
  }
  return out;
}
