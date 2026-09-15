import "server-only";

import { parseEnvBlob } from "../../migration/map/env";
import { saveSharedVar } from "../shared-vars/authoring";
import { visibleSharedVarIdsByKey } from "../shared-vars/visibility";
import type { Report } from "./run-report";

// carrying a key wins - ponytail: first-level-wins; compare values if a report line naming the winner is asked for.
export type SharedIndex = Map<string, { varId: string; value: string }>;

export async function importSharedVars(
  blob: string | null | undefined,
  opts: {
    teamId: string;
    label: string;
    environmentIds: string[];
    projectIds: string[];
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
    if (index.has(key)) continue;
    const here = already.get(key);
    if (here) {
      index.set(key, { varId: here, value });
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
      index.set(key, { varId, value });
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
