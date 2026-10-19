import "server-only";

import { parseEnvBlob, type SharedRefLevel } from "../../migration/map/env";
import { saveSharedVar } from "../shared-vars/authoring";
import { visibleSharedVarIdsByKey } from "../shared-vars/visibility";
import type { Report } from "./run-report";

// Keyed by level and name: a team's X and an environment's X are two variables.
export type SharedIndex = Map<string, { varId: string; value: string }>;

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
): { varId: string; value: string } | undefined {
  return (
    index.get(`${level}.${key}`) ??
    NARROW_FIRST.map((l) => index.get(`${l}.${key}`)).find(Boolean)
  );
}

export async function importSharedVars(
  blob: string | null | undefined,
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
  const entries = parseEnvBlob(blob);
  if (entries.length === 0) return;

  const already = await visibleSharedVarIdsByKey(opts.teamId);

  for (const { key, value } of entries) {
    const at = `${opts.level}.${key}`;
    if (index.has(at)) continue;
    // One this run created at another level is not "already in this team".
    const here = already.get(key)?.find((id) => !opts.created.has(id));
    if (here) {
      index.set(at, { varId: here, value });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message:
          "A shared variable with this name is already in this team. The apps that referenced it are linked to that one, whatever value it holds.",
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
      index.set(at, { varId, value });
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
