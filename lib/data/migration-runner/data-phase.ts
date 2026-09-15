import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { formatBytes } from "../../utils";
import { dataAlreadyCopiedInto, markDataCopyFailed } from "../data-copy";
import { moveMigrationServiceData } from "../migration-data/move";
import {
  planMigrationDataMove,
  type DataMoveService,
} from "../migration-data/plan";
import { credentialFor as connectCredential } from "../migration-import/gates";
import { importRunMembers } from "../migration-import/member-invites";
import { finishMigration } from "../migration-import/run-lifecycle";
import { appendRunItem } from "../migration-import/run-report";
import { isCopyAborted } from "../volume-migration";
import { beat, setProgress } from "./heartbeat";
import type { RunCredential, RunRow } from "./runner-state";
import {
  LeaseLost,
  PROGRESS_MS,
  lostLeases,
  panelNameFor,
} from "./runner-state";
import { stopped } from "./stop";

async function markUncopied(
  row: RunRow,
  services: DataMoveService[],
  why: string,
): Promise<void> {
  for (const d of services) {
    const landed = await dataAlreadyCopiedInto(row.id, d.targetId);
    const reason = `${d.sourceName}'s data was not copied: ${why}`;
    if (!landed)
      await markDataCopyFailed({ kind: d.targetKind, id: d.targetId }, reason);
    await appendRunItem(row.id, panelNameFor(row), {
      path: d.path,
      sourceKind: d.sourceKind,
      sourceId: d.sourceId,
      sourceName: d.sourceName,
      outcome: landed ? "manual" : "failed",
      targetKind: d.targetKind,
      targetId: d.targetId,
      message: landed
        ? `${d.sourceName} was read again and ${why} - its data had already been copied into ${d.targetName}, which keeps it.`
        : `${reason}. ${d.targetName} is running on the empty storage Deplo created for it - bring the data over before anyone uses it, or choose "Deploy anyway" to accept starting without it.`,
    });
  }
}

const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_RATIO = 0.1;

async function noteTightDisks(row: RunRow, serverIds: string[]): Promise<void> {
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
  const { formatBytes } = await import("../../utils");
  for (const id of [...new Set(serverIds)]) {
    let info;
    try {
      info = await fetchHostInfo(id);
    } catch {
      continue;
    }
    const total = info.diskTotalBytes;
    const free = Math.max(0, total - info.diskUsedBytes);
    if (total <= 0) continue;
    if (free >= DISK_FLOOR_BYTES && free / total >= DISK_FLOOR_RATIO) continue;
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Data",
      sourceKind: "data",
      sourceName: "disk",
      outcome: "manual",
      message: `The machine receiving this data has ${formatBytes(free)} free of ${formatBytes(total)}. A copy writes a second copy of everything before the old one goes, so free some room first.`,
    });
  }
}

export async function runDataPhase(
  row: RunRow,
  c: RunCredential,
): Promise<void> {
  await beat(row.id);
  const planned = await planMigrationDataMove({
    url: c.url,
    apiKey: c.apiKey,
    kind: c.kind,
    runId: row.id,
  });
  for (const d of planned)
    for (const note of d.notes)
      await appendRunItem(row.id, panelNameFor(row), {
        path: d.path,
        sourceKind: "data",
        sourceName: d.sourceName,
        outcome: "manual",
        message: note,
      });

  const planning = planned.filter((d) => d.volumes.length > 0);
  await noteTightDisks(
    row,
    planning.map((d) => d.targetServerId).filter((id) => id != null),
  );
  const unreachable = planning.filter((d) => !d.sourceReachable);
  const movable = planning.filter((d) => d.sourceReachable);
  if (unreachable.length > 0) {
    await markUncopied(
      row,
      unreachable,
      "Deplo has no way to reach the machine it is on",
    );
    if (movable.length === 0)
      throw new Error(
        `Deplo cannot reach the machine ${unreachable[0].sourceName}'s data is on, so no data was copied and nothing was stopped on ${panelNameFor(row)}.`,
      );
  }

  await getDb()
    .update(runsTable)
    .set({ totalSteps: movable.length, doneSteps: 0 })
    .where(eq(runsTable.id, row.id));

  let failedHere = unreachable.length;
  const deadMachines = new Set<string>();
  for (const [i, d] of movable.entries()) {
    if (deadMachines.has(d.sourceServerId)) {
      await markUncopied(
        row,
        [d],
        "the machine it is on stopped answering earlier in this run",
      );
      failedHere++;
      continue;
    }
    if (await stopped(row.id)) {
      return;
    }
    await beat(row.id);
    await setProgress(row.id, { doneSteps: i, stepLabel: d.sourceName });
    let copied = 0;
    let shownAt = 0;
    let res: Awaited<ReturnType<typeof moveMigrationServiceData>>;
    try {
      res = await moveMigrationServiceData({
        url: c.url,
        apiKey: c.apiKey,
        kind: c.kind,
        runId: row.id,
        sourceKind: d.sourceKind,
        sourceId: d.sourceId,
        onBytes: (chunk) => {
          copied += chunk;
          const now = Date.now();
          if (now - shownAt < PROGRESS_MS) return;
          shownAt = now;
          void setProgress(row.id, {
            stepLabel: `${d.sourceName} - ${formatBytes(copied)}`,
          }).catch(() => {});
        },
      });
    } catch (e) {
      if (isCopyAborted(e)) {
        if (lostLeases.has(row.id)) throw new LeaseLost(row.id);
        await stopped(row.id);
        return;
      }
      const why = e instanceof Error ? e.message : String(e);
      await markUncopied(row, [d], why);
      failedHere++;
      continue;
    }
    if (res.sourceGone) {
      failedHere++;
      deadMachines.add(d.sourceServerId);
    }
  }

  await setProgress(row.id, { doneSteps: movable.length, stepLabel: null });
  if (failedHere > 0)
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Migration",
      sourceKind: "run",
      sourceName: "Migration",
      outcome: "manual",
      message: `${failedHere} service(s) could not have their data cut over. Each is named above and refuses to deploy until you bring its data across yourself or choose "Deploy anyway" on its page.`,
    });
  try {
    await importRunMembers(row.id, await connectCredential(c));
  } catch (e) {
    console.error("[migration] bringing the members over failed:", e);
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Members",
      sourceKind: "member",
      sourceName: "Members",
      outcome: "failed",
      message: `The people on this team could not be brought over: ${
        e instanceof Error ? e.message : String(e)
      } Invite them from Members.`,
    });
  }
  await finishMigration(row.id);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, row.id));
  publishMigrationChanged();
  void import("./run-loop").then((m) => m.runMigrationTick()).catch(() => {});
}
