import type { EnvTarget } from "../types/env";

export type EnvEntryType = "plain" | "secret";

export interface TargetedEnvEntry {
  appId: string;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

export interface AutoInjectedEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

export interface SharedVarEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: EnvEntryType;
}

export interface PreviewOverrideEntry {
  key: string;
  valueEnc: string;
  type: EnvEntryType;
}

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
