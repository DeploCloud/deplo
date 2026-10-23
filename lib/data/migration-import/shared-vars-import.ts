import "server-only";

import {
  envEntriesOf,
  type EnvPair,
  type SharedRefLevel,
} from "../../migration/map/env";
import { saveSharedVar } from "../shared-vars/authoring";
import { tryDecryptSecret } from "../../crypto";
import { visibleSharedVarsByKey } from "../shared-vars/visibility";
import type { Report } from "./run-report";

// Keyed by level and name: a team's X and an environment's X are two variables.
// varId null: a variable here holds another value, so apps keep the source's as their own.
// created: this run made it, so only apps it brought over are linked to it.
export interface SharedEntry {
  varId: string | null;
  value: string;
  created?: boolean;
}
export type SharedIndex = Map<string, SharedEntry>;

const NARROW_FIRST: SharedRefLevel[] = [
  "environment",
  "server",
  "project",
  "team",
];

export function sharedEntry(
  index: SharedIndex,
  level: SharedRefLevel,
  key: string,
): SharedEntry | undefined {
  return (
    index.get(`${level}.${key}`) ??
    NARROW_FIRST.map((l) => index.get(`${l}.${key}`)).find(Boolean)
  );
}

export async function importSharedVars(
  vars:
    { env?: string | null; envEntries?: EnvPair[] | null } | null | undefined,
  opts: {
    teamId: string;
    label: string;
    environmentIds: string[];
    projectIds: string[];
    level: SharedRefLevel;
    // Every variable this import created, across levels and environments.
    created: Set<string>;
    teamWide?: boolean;
    secretKeys?: string[] | null;
    scopeNote?: string;
    report: Report;
  },
  index: SharedIndex,
): Promise<void> {
  const entries = envEntriesOf(vars);
  if (entries.length === 0) return;

  const already = await visibleSharedVarsByKey(opts.teamId);

  for (const { key, value } of entries) {
    const at = `${opts.level}.${key}`;
    if (index.has(at)) continue;
    // One this run created at another level is not "already in this team".
    const here = (already.get(key) ?? []).filter(
      (v) => !opts.created.has(v.id),
    );
    const same = here.find((v) => {
      const open = tryDecryptSecret(v.valueEnc);
      return open.ok && open.value === value;
    });
    if (same) {
      index.set(at, { varId: same.id, value });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message:
          "A shared variable with this name and value is already in this team. The apps that referenced it are linked to that one.",
      });
      continue;
    }
    if (here.length > 0) {
      index.set(at, { varId: null, value });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message:
          "A shared variable with this name is already in this team with a different value, so it was left as it is. The apps that referenced it on {panel} keep {panel}'s value as their own variable.",
      });
      continue;
    }
    try {
      const varId = await saveSharedVar({
        key,
        value,
        type: opts.secretKeys?.includes(key) ? "secret" : "plain",
        teamIds: opts.teamWide ? [opts.teamId] : [],
        environmentIds: opts.environmentIds,
        projectIds: opts.projectIds,
        appIds: undefined,
      });
      index.set(at, { varId, value, created: true });
      opts.created.add(varId);
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "created",
        targetKind: "shared-var",
        message:
          (opts.scopeNote ? `${opts.scopeNote} ` : "") +
          "Only an app that referenced it on {panel} is linked to it - link others under Variables.",
      });
    } catch (e) {
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "failed",
        targetKind: "shared-var",
        message:
          e instanceof Error ? e.message : "Could not create the variable.",
      });
    }
  }
}
