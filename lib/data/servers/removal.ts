import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backupDestination as destinationTable } from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { isDeploHostServer } from "../../deploy/domains";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { instancePublicBaseUrl } from "../instance-settings/settings-store";
import { recordActivity } from "../activity";
import { pendingTeardownsForServer } from "../teardown-queue";
import { controlPlaneCert, uninstallCommand } from "../../agent/bootstrap";
import { getServerById, serverRole } from "./roster";

// What removeServer hands back to the operator.
export interface ServerRemoval {
  // The paste-on-the-server command that uninstalls the agent. ALWAYS returned -
  // removal never cleans the host.
  uninstallCommand: string;
  // A non-blocking hazard the operator must know about, or null.
  warning: string | null;
}

async function publicBaseUrl(): Promise<string> {
  return instancePublicBaseUrl();
}

async function hostUninstallCommand(): Promise<string> {
  const baseUrl = await publicBaseUrl();
  const { insecure } = await controlPlaneCert(baseUrl);
  return uninstallCommand({ baseUrl, insecure });
}

// agentUninstallCommand is the paste-on-the-host command that takes Deplo's agent
// back off a machine - the row that needs it is the one Deplo cannot reach.
export async function agentUninstallCommand(): Promise<string> {
  await requireActiveTeamId();
  return hostUninstallCommand();
}

function nameList(names: string[], max = 5): string {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} …and ${rest} more` : shown;
}

// assertNoWorkloads refuses when the host still RUNS something, BEFORE anything is
// touched: both `server_id` FKs are RESTRICT, but a raw FK error tells nobody anything.
export async function assertNoWorkloads(id: string): Promise<void> {
  const [apps, dbs] = await Promise.all([
    getDb()
      .select({ slug: appsTable.slug })
      .from(appsTable)
      .where(eq(appsTable.serverId, id)),
    getDb()
      .select({ name: databasesTable.name })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, id)),
  ]);
  if (apps.length > 0)
    throw new Error(
      `Move or delete the apps on this server first, still assigned: ` +
        `${nameList(apps.map((a) => a.slug))}`,
    );
  if (dbs.length > 0)
    throw new Error(
      `Move or delete the databases on this server first, still hosted here: ` +
        `${nameList(dbs.map((d) => d.name))}`,
    );
}

// Everything assertNoWorkloads refuses plus the backup destinations kept here. It
// runs before the trust revoke, so a blocked removal has no side effects at all.
async function assertServerRemovable(id: string): Promise<void> {
  await assertNoWorkloads(id);
  const destinations = await getDb()
    .select({ name: destinationTable.name, teamId: destinationTable.teamId })
    .from(destinationTable)
    .where(eq(destinationTable.serverId, id));
  if (destinations.length > 0)
    throw new Error(
      `Remove the backup destinations kept on this server first, still pointing ` +
        `here: ${nameList(destinations.map((d) => d.name))}. Each one belongs to a ` +
        `team, whose members remove it from Storage → Destinations.`,
    );
}

// removeServer forgets a server, revoking trust first so even a box we can no
// longer reach never keeps a valid badge.
export async function removeServer(id: string): Promise<ServerRemoval> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return removeServerRow(id, user.name, teamId);
}

// The removal itself, with NO gate of its own.
async function removeServerRow(
  id: string,
  actorName: string,
  teamId: string,
): Promise<ServerRemoval> {
  const user = { name: actorName };
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  // (0) The host running Deplo itself is NOT removable, by anyone, ever.
  if (isDeploHostServer(server))
    throw new Error(
      `${server.name} is the host running Deplo itself - it can't be removed, ` +
        `because doing so would cut this dashboard off from its own server.`,
    );

  // (a) Block on live workloads - before any side effect.
  await assertServerRemovable(id);

  // An App mid-move OFF this server is NOT a blocker (the source host may be the
  // thing that died), but its volumes still sit here and
  // `apps.migrate_from_server_id` is SET NULL on delete, so the marker vanishes.
  const stranded = await getDb()
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.migrateFromServerId, id));

  // Queued teardowns go with the host: retrying them would dial an address that
  // is no longer ours.
  const abandoned = await pendingTeardownsForServer(id);

  // (b) Revoke trust before the delete: if anything below fails, the agent's
  // badge is already dead.
  const pinned = server.agent?.certFingerprint ?? "";
  await getDb()
    .update(serversTable)
    .set({ agentCertFingerprint: "" })
    .where(eq(serversTable.id, id));

  // (c) Delete - restoring the pin if it fails, so we never leave a server that
  // is present in the table yet can never be dialed again.
  try {
    await getDb().delete(serversTable).where(eq(serversTable.id, id));
  } catch (e) {
    await getDb()
      .update(serversTable)
      .set({ agentCertFingerprint: pinned })
      .where(eq(serversTable.id, id));
    throw new Error(
      `Could not remove ${server.name} (its trust was restored): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await recordActivity(
    "server",
    `Removed server ${server.name}`,
    user.name,
    null,
    teamId,
  );
  if (abandoned > 0)
    await recordActivity(
      "server",
      `${abandoned} pending teardown${abandoned === 1 ? "" : "s"} on ${server.name} ` +
        `${abandoned === 1 ? "was" : "were"} dropped with the server.`,
      user.name,
      null,
      teamId,
    );

  const warning =
    stranded.length > 0
      ? `${nameList(stranded.map((a) => a.slug))} ${stranded.length === 1 ? "was" : "were"} ` +
        `mid-move off ${server.name}: the data volumes still live on that host and Deplo ` +
        `has just forgotten where. Copy them off before you uninstall with --purge-data.`
      : null;

  return {
    uninstallCommand: await hostUninstallCommand(),
    warning,
  };
}

// What uninstallServerAgent hands back.
export interface ServerUninstall {
  // True when the host is clean AND the row is gone. False leaves both in place.
  removed: boolean;
  // The host-side one-liner, ALWAYS returned - on failure it is the only way through.
  uninstallCommand: string;
  // Why it did not happen, or null. Surfaced verbatim in the UI.
  error: string | null;
  // A non-blocking hazard, or null - same shape as ServerRemoval.
  warning: string | null;
}

// uninstallServerAgent takes Deplo off a MIGRATION SOURCE: uninstall the agent
// from the host, then forget the server.
export async function uninstallServerAgent(
  id: string,
): Promise<ServerUninstall> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return uninstallMigrationSource(id, user.name, teamId);
}

// The uninstall itself, with NO capability gate - also what the automatic sweep
// does with nobody signed in at all.
export async function uninstallMigrationSource(
  id: string,
  actorName: string,
  teamId: string,
  deadlineMs?: number,
): Promise<ServerUninstall> {
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  const command = await hostUninstallCommand();

  // Scoped to the one role that asked for it: an ordinary server's removal is a
  // deliberate, unchanged flow (ADR-0011).
  if (serverRole(server) !== "import")
    throw new Error(
      `${server.name} is a server in your fleet, not a migration source. ` +
        `Remove it from its own page if you want it gone.`,
    );

  await assertServerRemovable(id);

  if (server.agent?.certFingerprint) {
    try {
      const { selfUninstallServerAgent } =
        await import("../../infra/agent-client/agent-lifecycle");
      const removed = await selfUninstallServerAgent(id, deadlineMs);
      await recordActivity(
        "server",
        `Uninstalled the agent from ${server.name} (${removed.join(", ") || "nothing found"})`,
        actorName,
        null,
        teamId,
      );
    } catch (e) {
      return {
        removed: false,
        uninstallCommand: command,
        error: e instanceof Error ? e.message : String(e),
        warning: null,
      };
    }
  }

  const { warning } = await removeServerRow(id, actorName, teamId);
  return { removed: true, uninstallCommand: command, error: null, warning };
}
