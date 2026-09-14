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

// Say, on the resource itself and in the report, that a service's data never
// came across: an empty volume is indistinguishable from one that worked, and
// that is the shape data loss takes when nobody is told.
async function markUncopied(
  row: RunRow,
  services: DataMoveService[],
  why: string,
): Promise<void> {
  for (const d of services) {
    // A retry of a service this run ALREADY copied says nothing about the data:
    // the bytes are in the volume, and the row must not be blocked over it.
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

/** Under this, a copy is walking into a disk that cannot hold what it carries. */
const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_RATIO = 0.1;

// The machine about to RECEIVE the bytes, before any of them move: a copy into a
// disk at 93% used to fail part way with nothing having said why.
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
  // Every reason a service will not have its data copied is SAID. These notes
  // are the whole value of the report.
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
    // Named, and then STEPPED OVER: one machine nobody can reach is not a reason
    // to leave the services on the machines that answer sitting on empty storage.
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
  // A machine that stopped answering mid-run takes only ITS OWN services down
  // with it: the rest of the fleet still has data to move.
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
      // Stopped by hand: the undo has already taken everything back out, so
      // there is nothing left to mark.
      return;
    }
    await beat(row.id);
    await setProgress(row.id, { doneSteps: i, stepLabel: d.sourceName });
    // The bytes, while they cross. One service is ONE step here, so without this
    // a 15 GB volume is an hour of a progress line that got read as a dead run.
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
          // Throttled, because the relay hands us a chunk roughly every megabyte.
          // Fire-and-forget: the copy does not wait on its own progress line.
          const now = Date.now();
          if (now - shownAt < PROGRESS_MS) return;
          shownAt = now;
          void setProgress(row.id, {
            stepLabel: `${d.sourceName} - ${formatBytes(copied)}`,
          }).catch(() => {});
        },
      });
    } catch (e) {
      // The copy was cut by a Stop, not by a fault - or by the lease going to
      // another control plane, and then this one writes nothing more at all.
      if (isCopyAborted(e)) {
        if (lostLeases.has(row.id)) throw new LeaseLost(row.id);
        await stopped(row.id);
        return;
      }
      // One service that would not cut over is a line in the report, not the end
      // of the migration.
      const why = e instanceof Error ? e.message : String(e);
      await markUncopied(row, [d], why);
      failedHere++;
      continue;
    }
    // A failed VOLUME is a line in the report. A failed MACHINE takes the services
    // that share it, and nothing else: the rest of the run carries on.
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
  // The people, while the token is still here to read them with.
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
  // The next team of this panel starts on the very next tick, so a queue moves
  // as fast as a person would.
  void import("./run-loop").then((m) => m.runMigrationTick()).catch(() => {});
}
