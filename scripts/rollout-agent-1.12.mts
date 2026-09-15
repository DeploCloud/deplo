import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { apps } from "../lib/db/schema/control-plane/apps";
import { deployments } from "../lib/db/schema/control-plane/deployments";
import { markServerSeen } from "../lib/data/servers/agent-handshake";
import { listAllServers } from "../lib/data/servers/roster";
import { selfUpdateServerAgent } from "../lib/infra/agent-client/agent-lifecycle";
import { runAgentCleanup } from "../lib/infra/agent-client/docker-cleanup";
import { agentPreflight } from "../lib/infra/agent-client/preflight";
import { CleanupScope } from "../lib/agent/gen/agent";

const TARGET = "1.12.1";
const ORDER = [
  "srv_f47d8cba7db4c813",
  "srv_07b0be4ab9ef9533",
  "srv_3667cf1973005952",
];
const REQUIRED_CAPS = [
  "self-update",
  "backup",
  "docker-cleanup",
  "container-stats",
];

async function inFlightDeploys(serverId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: deployments.id })
    .from(deployments)
    .leftJoin(apps, eq(apps.id, deployments.appId))
    .where(
      and(
        inArray(deployments.status, ["queued", "building"]),
        eq(sql`coalesce(${deployments.serverId}, ${apps.serverId})`, serverId),
      ),
    );
  return rows.length;
}

async function updateOne(serverId: string, name: string): Promise<void> {
  const busy = await inFlightDeploys(serverId);
  if (busy > 0) {
    throw new Error(
      `${name}: ${busy} in-flight deploy(s) - a self-update re-exec would kill their streams. Re-run later.`,
    );
  }

  console.log(`[${name}] updating…`);
  const { version } = await selfUpdateServerAgent(serverId);
  await markServerSeen(serverId, version);
  console.log(`[${name}] agent replied ${version}, waiting for the re-exec…`);
  await new Promise((r) => setTimeout(r, 4000));

  const hello = await agentPreflight(serverId);
  if (hello.agentVersion !== TARGET) {
    throw new Error(
      `${name}: Hello says ${hello.agentVersion}, want ${TARGET} - STOP the rollout`,
    );
  }
  const missing = REQUIRED_CAPS.filter((c) => !hello.capabilities.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `${name}: capabilities disappeared: ${missing.join(", ")} - STOP the rollout`,
    );
  }
  await markServerSeen(serverId, hello.agentVersion);

  const dry = await runAgentCleanup(serverId, {
    scopes: [
      CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
      CleanupScope.CLEANUP_SCOPE_DANGLING_IMAGES,
      CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE,
      CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
    ],
    dryRun: true,
    minAgeHours: 24,
    keepImagesPerApp: 1,
    keepPerSlug: {},
    liveSlugs: [],
    liveNetworks: [],
  });
  if (!dry.ok) throw new Error(`${name}: dry-run cleanup failed: ${dry.error}`);
  for (const r of dry.results ?? []) {
    console.log(
      `[${name}]   dry-run scope=${r.scope} items=${r.itemsRemoved} bytes=${r.reclaimedBytes} skipped=${r.skipped}${r.error ? ` error=${r.error}` : ""}`,
    );
  }
  console.log(`[${name}] OK on ${hello.agentVersion}`);
}

async function main(): Promise<void> {
  const servers = await listAllServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  for (const id of ORDER) {
    const s = byId.get(id);
    if (!s) throw new Error(`server ${id} not found`);
    if (!s.agent?.certFingerprint) {
      console.log(`[${s.name}] not provisioned - skipping`);
      continue;
    }
    await updateOne(id, s.name);
  }
  console.log("fleet on " + TARGET);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
