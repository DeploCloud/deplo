import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
} from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import {
  serverTeams as serverTeamsTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { getCurrentUser } from "../../auth/current-user";
import { holdsTeamWideCapability, isInstanceAdmin } from "../../membership";
import { uninstallMigrationSource } from "../servers/removal";
import { listServersForTeam } from "../servers/roster";
import { recordActivity } from "../activity";
import { assertImportGate, assertPanelReadGate } from "./gates";
import { appendRunItem, refreshCounts } from "./run-report";
import { activeMigrationForTeam } from "./run-queries";

// A source is granted to exactly one team at registration and every lookup that reads
// it is team-scoped, so a source left in another team blocks the run and strands its
// agent: hand them to the team the migration now lands in.
export async function adoptMigrationSources(
  teamId: string,
  addresses: Set<string>,
): Promise<void> {
  if (addresses.size === 0) return;
  // LEFT join: a source whose team was deleted has no team row at all, and is
  // the one most in need of a home - its agent is still on the machine.
  const rows = await getDb()
    .select({
      id: serversTable.id,
      ip: serversTable.ip,
      host: serversTable.host,
      teamId: serverTeamsTable.teamId,
    })
    .from(serversTable)
    .leftJoin(serverTeamsTable, eq(serverTeamsTable.serverId, serversTable.id))
    .where(and(eq(serversTable.importOnly, true), notBeingRemoved()));
  const admin = await isInstanceAdmin();
  let moved = 0;
  for (const r of rows) {
    if (r.teamId === teamId) continue;
    const at = [r.ip, r.host].map((a) => a?.trim().toLowerCase() ?? "");
    if (!at.some((a) => a && addresses.has(a))) continue;
    if (r.teamId === null) {
      await getDb()
        .insert(serverTeamsTable)
        .values({ serverId: r.id, teamId })
        .onConflictDoNothing();
      await keepSourceMachine(r.id);
      moved++;
      continue;
    }
    if (!admin && !(await holdsTeamWideCapability(r.teamId, "create_projects")))
      continue;
    if (await activeMigrationForTeam(r.teamId)) continue;
    await getDb()
      .update(serverTeamsTable)
      .set({ teamId })
      .where(
        and(
          eq(serverTeamsTable.serverId, r.id),
          eq(serverTeamsTable.teamId, r.teamId),
        ),
      );
    await keepSourceMachine(r.id);
    moved++;
  }
  if (moved > 0)
    await recordActivity(
      "server",
      `Moved ${moved} migration source ${moved === 1 ? "machine" : "machines"} to this team`,
      (await getCurrentUser())?.name ?? "Migrations",
      null,
      teamId,
    );
}

export async function handOverMigrationSources(
  // The team they are with. Omitted takes them from whichever team holds them, which
  // is what the queue needs: the turn before this one picked that team.
  fromTeamId?: string | null,
): Promise<number> {
  const { teamId } = await assertImportGate();
  if (fromTeamId === teamId) return 0;
  const held = await getDb()
    .select({ id: serversTable.id, teamId: serverTeamsTable.teamId })
    .from(serversTable)
    .innerJoin(serverTeamsTable, eq(serverTeamsTable.serverId, serversTable.id))
    .where(
      and(
        eq(serversTable.importOnly, true),
        fromTeamId
          ? eq(serverTeamsTable.teamId, fromTeamId)
          : ne(serverTeamsTable.teamId, teamId),
        // One the reaper has already STARTED on belongs to it; one merely
        // pencilled in is a machine somebody came back to.
        notBeingRemoved(),
      ),
    );
  if (held.length === 0) return 0;
  for (const from of new Set(held.map((r) => r.teamId))) {
    // Prove the mover could use those machines BEFORE, not only where they land -
    // or is the admin whose instance page registered them.
    if (
      !(await holdsTeamWideCapability(from, "create_projects")) &&
      !(await isInstanceAdmin())
    )
      throw new Error("You cannot move a migration source out of that team.");
    // A run in flight is reading their disks right now; they are not yours to move.
    if (await activeMigrationForTeam(from))
      throw new Error(
        "A migration is running in the team you are moving away from, so the machines it reads stay there.",
      );
  }
  const ids = held.map((r) => r.id);
  await getDb()
    .update(serverTeamsTable)
    .set({ teamId })
    .where(
      and(
        inArray(serverTeamsTable.serverId, ids),
        ne(serverTeamsTable.teamId, teamId),
      ),
    );
  for (const id of ids) await keepSourceMachine(id);
  // Both trails: one team's machines left it, and they are another's now.
  const actor = (await getCurrentUser())?.name ?? "Migrations";
  const what = ids.length === 1 ? "machine" : "machines";
  for (const from of new Set(held.map((r) => r.teamId)))
    await recordActivity(
      "server",
      `Moved ${ids.length} migration source ${what} to another team`,
      actor,
      null,
      from,
    );
  await recordActivity(
    "server",
    `Took over ${ids.length} migration source ${what} from another team`,
    actor,
    null,
    teamId,
  );
  return ids.length;
}

// Attempts before Deplo asks a person instead: the one made while the wizard is
// still open, then two from the sweep.
const UNINSTALL_ATTEMPTS = 3;

// How long the ladder waits before attempt N+1. Short, because nothing is retried
// here except reaching a machine that was answering a moment ago.
const UNINSTALL_BACKOFF_MS = [60_000, 5 * 60_000];

// The deadline for the ONE attempt made inline, while somebody watches the wizard finish.
const UNINSTALL_INLINE_DEADLINE_MS = 15_000;

// How many stuck sources one sweep tick picks up.
const UNINSTALL_DRAIN_BATCH = 8;

// The last act of a migration: take Deplo's agent back off every machine it was
// installed on to read the panel, and forget those rows.
export async function removeMigrationSources(
  runId: string,
  teamId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const sources = (await listServersForTeam(teamId)).filter(
    (s) => s.importOnly,
  );
  if (sources.length === 0) return;

  if (!opts.force && (await hasStrandedVolume(runId))) {
    for (const s of sources)
      await appendRunItem(runId, "the panel", {
        path: s.name,
        sourceKind: "server",
        sourceName: s.name,
        outcome: "manual",
        // Never "the data is on THIS machine": the commonest reason a copy left
        // data behind is that Deplo asked the wrong machine, and this is exactly
        // the one that did not have it.
        message:
          `Deplo's agent is still on ${s.name}: this migration left data that ` +
          `has not been copied yet, and its agents are how Deplo reaches it. ` +
          `Remove it once the copy is done.`,
      });
    return;
  }

  const [run] = await getDb()
    .select({ actor: runsTable.actor })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  await scheduleSourceUninstalls(
    sources,
    runId,
    teamId,
    run?.actor ?? "Migrations",
  );
}

// Data this run could not bring across: the bytes are still on the source host and its
// agent is the only way to fetch them, so nothing may take that agent off until a person
// says so. A failed volume line is one signal, `data_copy_error` the other.
async function hasStrandedVolume(runId: string): Promise<boolean> {
  const failedVolume = await getDb()
    .select({
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        eq(itemsTable.sourceKind, "volume"),
        eq(itemsTable.outcome, "failed"),
      ),
    );

  const rows = await getDb()
    .select({
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(and(eq(itemsTable.runId, runId), eq(itemsTable.outcome, "created")));
  const idsOf = (kind: string) => [
    ...new Set(
      rows
        .filter((r) => r.targetKind === kind && r.targetId)
        .map((r) => r.targetId!),
    ),
  ];
  // A report line is HISTORY. The marker on the resource is the current state, and
  // a recopy clears it - read the line alone and one failure held the agent on the
  // source machine for good, with no way in the UI to say the data had arrived.
  const stillMarked = async (kind: string, ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const table = kind === "app" ? appsTable : databasesTable;
    const hit = await getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, ids), ne(table.dataCopyError, "")))
      .limit(1);
    return hit.length > 0;
  };
  for (const kind of ["app", "database"]) {
    const ids = [
      ...new Set(
        failedVolume
          .filter((r) => r.targetKind === kind && r.targetId)
          .map((r) => r.targetId!),
      ),
    ];
    if (await stillMarked(kind, ids)) return true;
  }
  // A failed line that names no target at all: nothing can clear it, so it stands.
  if (failedVolume.some((r) => !r.targetId)) return true;

  const appIds = idsOf("app");
  if (appIds.length > 0) {
    const hit = await getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(
        and(inArray(appsTable.id, appIds), ne(appsTable.dataCopyError, "")),
      )
      .limit(1);
    if (hit.length > 0) return true;
  }
  const dbIds = idsOf("database");
  if (dbIds.length > 0) {
    const hit = await getDb()
      .select({ id: databasesTable.id })
      .from(databasesTable)
      .where(
        and(
          inArray(databasesTable.id, dbIds),
          ne(databasesTable.dataCopyError, ""),
        ),
      )
      .limit(1);
    if (hit.length > 0) return true;
  }
  return false;
}

// How long a walked-away wizard's machines are left alone before Deplo takes its agent
// off them. Coming back inside it costs nothing.
const ABANDON_GRACE_MS = 10 * 60_000;

// Nothing has been TRIED on this machine yet, so a wizard may claim it back: never
// scheduled, or scheduled and not attempted.
function notBeingRemoved() {
  return or(
    isNull(serversTable.uninstallNextAt),
    and(
      eq(serversTable.uninstallAttempts, 0),
      eq(serversTable.uninstallError, ""),
    ),
  );
}

// This machine is in use again: take it off the reaper's list.
async function keepSourceMachine(id: string): Promise<void> {
  await getDb()
    .update(serversTable)
    .set({ uninstallNextAt: null, uninstallRunId: null, uninstallAttempts: 0 })
    .where(
      and(eq(serversTable.id, id), isNotNull(serversTable.uninstallNextAt)),
    );
}

// Put every one of these sources on the uninstall ladder and take the first rung now.
// `runId` is null when nobody's report is waiting on the answer.
async function scheduleSourceUninstalls(
  sources: { id: string; name: string }[],
  runId: string | null,
  teamId: string,
  actor: string,
  // Wait this long before the first rung, and let the sweep take it: leaving a page for
  // a minute must not cost the machines.
  graceMs = 0,
): Promise<void> {
  for (const s of sources) {
    // The intent FIRST, so a process that dies on the next line still leaves a
    // row the sweep will pick up. `attempts: 0` because the try below is the
    // first one.
    await getDb()
      .update(serversTable)
      .set({
        uninstallRunId: runId,
        uninstallAttempts: 0,
        uninstallError: "",
        uninstallNextAt: new Date(Date.now() + graceMs).toISOString(),
      })
      .where(eq(serversTable.id, s.id));
    if (graceMs > 0) continue;
    await attemptSourceUninstall(
      { id: s.id, name: s.name, attempts: 0, runId },
      teamId,
      actor,
      new Date(),
      UNINSTALL_INLINE_DEADLINE_MS,
    );
  }
}

// abandonMigration - the wizard was walked away from, and the machines it was reading
// are somebody else's. The identity is the person leaving, and the capability is the
// one that registered the sources in the first place.
export async function abandonMigration(): Promise<number> {
  const { teamId } = await assertPanelReadGate();
  const actor = (await getCurrentUser())?.name ?? "Migrations";

  const [latest] = await getDb()
    .select({ id: runsTable.id, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId))
    .orderBy(desc(runsTable.seq))
    .limit(1);
  // `stopped` is a pause, not an ending: re-running is how a stopped migration is
  // resumed (see `stopMigration`), and it can only be resumed through the
  // agents that are still on those machines.
  if (latest?.status === "running" || latest?.status === "stopped") return 0;
  if (latest && (await hasStrandedVolume(latest.id))) return 0;

  const sources = (await listServersForTeam(teamId)).filter(
    // Already on the ladder, or already given up on: both are somebody else's
    // decision to leave alone. `uninstallError` is what puts the machine in
    // front of a person, and re-arming it would hide it again.
    (s) => s.importOnly && !s.uninstallPending && !s.uninstallError,
  );
  if (sources.length === 0) return 0;
  // Pencilled in, not torn down: the person may be back in a minute, and the
  // wizard that comes back takes them off the list again.
  await scheduleSourceUninstalls(
    sources,
    null,
    teamId,
    actor,
    ABANDON_GRACE_MS,
  );
  return sources.length;
}

// One attempt at taking Deplo off one migration source, and what to do with the answer.
async function attemptSourceUninstall(
  source: { id: string; name: string; attempts: number; runId: string | null },
  teamId: string,
  actor: string,
  now: Date,
  deadlineMs?: number,
): Promise<void> {
  let error = "";
  try {
    const res = await uninstallMigrationSource(
      source.id,
      actor,
      teamId,
      deadlineMs,
    );
    error = res.removed ? "" : (res.error ?? "the agent is still installed");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (!error) return;

  const attempts = source.attempts + 1;
  if (attempts < UNINSTALL_ATTEMPTS) {
    const wait =
      UNINSTALL_BACKOFF_MS[Math.min(attempts, UNINSTALL_BACKOFF_MS.length) - 1];
    await getDb()
      .update(serversTable)
      .set({
        uninstallAttempts: attempts,
        uninstallError: "",
        uninstallNextAt: new Date(now.getTime() + wait).toISOString(),
      })
      .where(eq(serversTable.id, source.id));
    return;
  }

  await getDb()
    .update(serversTable)
    .set({
      uninstallAttempts: attempts,
      uninstallError: error,
      uninstallNextAt: null,
    })
    .where(eq(serversTable.id, source.id));
  if (source.runId) {
    await appendRunItem(source.runId, "the panel", {
      path: source.name,
      sourceKind: "server",
      sourceName: source.name,
      outcome: "manual",
      message:
        `Deplo could not remove its own agent from ${source.name} after ` +
        `${UNINSTALL_ATTEMPTS} tries: ${error}. Remove it from Settings → Servers.`,
    });
    await refreshCounts(source.runId, teamId);
  }
  await recordActivity(
    "server",
    `Could not remove Deplo's agent from ${source.name} after ${UNINSTALL_ATTEMPTS} tries: ${error}`,
    actor,
    null,
    teamId,
  );
}

// drainMigrationSourceUninstalls - the sweep half: retry every migration source whose
// uninstall is still owed. The predicate is a DB state, so there is no catch-up window
// to miss - a tick that never ran costs nothing but the delay.
export async function drainMigrationSourceUninstalls(
  now: Date = new Date(),
): Promise<void> {
  const due = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      attempts: serversTable.uninstallAttempts,
      runId: serversTable.uninstallRunId,
    })
    .from(serversTable)
    .where(
      and(
        eq(serversTable.importOnly, true),
        isNotNull(serversTable.uninstallNextAt),
        lte(serversTable.uninstallNextAt, now.toISOString()),
      ),
    )
    .orderBy(asc(serversTable.uninstallNextAt))
    .limit(UNINSTALL_DRAIN_BATCH);

  for (const row of due) {
    // The team comes from the GRANT rather than the run: a migration source is
    // granted to exactly one team at registration, and that outlives the run row.
    const [grant] = await getDb()
      .select({ teamId: serverTeamsTable.teamId })
      .from(serverTeamsTable)
      .where(eq(serverTeamsTable.serverId, row.id))
      .limit(1);
    if (!grant) continue;
    // ANOTHER run is reading those disks right now: somebody left the wizard,
    // came back and started, and the reaper was about to pull the agent out from
    // under the copy. The run that asked for the uninstall still gets it.
    const [inFlight] = await getDb()
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(
        and(
          eq(runsTable.teamId, grant.teamId),
          eq(runsTable.status, "running"),
        ),
      )
      .limit(1);
    if (inFlight && inFlight.id !== row.runId) {
      await keepSourceMachine(row.id);
      continue;
    }
    const [run] = row.runId
      ? await getDb()
          .select({ actor: runsTable.actor })
          .from(runsTable)
          .where(eq(runsTable.id, row.runId))
          .limit(1)
      : [];
    await attemptSourceUninstall(
      row,
      grant.teamId,
      run?.actor ?? "Migrations",
      now,
    );
  }
}

// removeSourcesOfRun - the runner's door into what finishing does, for a queue that
// ended without a last run to do it.
export async function removeSourcesOfRun(
  runId: string,
  teamId: string,
): Promise<void> {
  await removeMigrationSources(runId, teamId);
}
