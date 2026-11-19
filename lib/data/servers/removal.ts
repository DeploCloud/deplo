import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { isDeploHostServer } from "../../deploy/domains";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { instancePublicBaseUrl } from "../instance-settings/settings-store";
import { recordActivity } from "../activity";
import { pendingTeardownsForServer } from "../teardown-queue";
import { controlPlaneCert, uninstallCommand } from "../../agent/bootstrap";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
import { clustersOfServer, pushClusterRosters } from "../clusters/relay";
import { markPreviewsOffline } from "../../deploy/preview-lifecycle/cluster-member";
import { getServerById, serverRole } from "./roster";
import { blockingRows } from "./removal-blockers";

export interface ServerRemoval {
  uninstallCommand: string;
  warning: string | null;
}

async function publicBaseUrl(): Promise<string> {
  return instancePublicBaseUrl();
}

async function hostUninstallCommand(): Promise<string> {
  const baseUrl = await publicBaseUrl();
  const { insecure, pin } = await controlPlaneCert(baseUrl);
  return uninstallCommand({ baseUrl, insecure, pin });
}

export async function agentUninstallCommand(): Promise<string> {
  await requireActiveTeamId();
  return hostUninstallCommand();
}

function nameList(names: string[], max = 5): string {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} …and ${rest} more` : shown;
}

function refusal(
  b: Awaited<ReturnType<typeof blockingRows>>,
  workloadsOnly = false,
): string | null {
  if (b.apps.length > 0)
    return (
      `Move or delete the apps on this server first, still assigned: ` +
      nameList(b.apps.map((a) => a.slug))
    );
  if (b.databases.length > 0)
    return (
      `Move or delete the databases on this server first, still hosted here: ` +
      nameList(b.databases.map((d) => d.name))
    );
  if (workloadsOnly) return null;
  if (b.clusters.length > 0)
    return `Move the leader of cluster ${nameList(b.clusters.map((c) => c.name))} to another server first.`;
  if (b.destinations.length > 0)
    return (
      `Remove the backup destinations kept on this server first, still pointing ` +
      `here: ${nameList(b.destinations.map((d) => d.name))}. The Remove server ` +
      `dialog on this server's page lists them and removes each one.`
    );
  return null;
}

export async function assertNoWorkloads(id: string): Promise<void> {
  const why = refusal(await blockingRows(id), true);
  if (why) throw new Error(why);
}

async function assertServerRemovable(id: string): Promise<void> {
  const why = refusal(await blockingRows(id));
  if (why) throw new Error(why);
}

export async function removeServer(id: string): Promise<ServerRemoval> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return removeServerRow(id, user.name, teamId);
}

async function removeServerRow(
  id: string,
  actorName: string,
  teamId: string,
): Promise<ServerRemoval> {
  const user = { name: actorName };
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  if (isDeploHostServer(server))
    throw new Error(
      `${server.name} is the host running Deplo itself - it can't be removed, ` +
        `because doing so would cut this dashboard off from its own server.`,
    );

  await assertServerRemovable(id);

  const stranded = await getDb()
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.migrateFromServerId, id));

  const abandoned = await pendingTeardownsForServer(id);

  const clusterIds = await clustersOfServer(id);
  // A preview that ran here is gone with it; the next push or a redeploy places it again (#212).
  // ponytail: marked before the delete, which clears the column; a refused delete leaves them offline until redeployed.
  await markPreviewsOffline(id);
  const pinned = server.agent?.certFingerprint ?? "";
  await getDb()
    .update(serversTable)
    .set({ agentCertFingerprint: "" })
    .where(eq(serversTable.id, id));

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
  dropAgentChannel(id);
  // A removed server's certificate leaves every cluster relay's roster at once.
  await pushClusterRosters(clusterIds);
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

export interface ServerUninstall {
  removed: boolean;
  uninstallCommand: string;
  error: string | null;
  warning: string | null;
}

export async function uninstallServerAgent(
  id: string,
): Promise<ServerUninstall> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return uninstallMigrationSource(id, user.name, teamId);
}

export async function uninstallMigrationSource(
  id: string,
  actorName: string,
  teamId: string,
  deadlineMs?: number,
): Promise<ServerUninstall> {
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  const command = await hostUninstallCommand();

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
