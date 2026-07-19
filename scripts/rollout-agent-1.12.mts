/**
 * Fleet rollout of deplo-agent v1.12.0 (the docker-cleanup retention fix).
 *
 * Follows docs/agents/fleet-rollout.md to the letter:
 *  - order: canary (neon-s1, fewest Apps) → neon-s2 → eu-main-1 (agent 0) LAST;
 *  - skip any server with an in-flight deploy (queued/building, via
 *    coalesce(deployments.server_id, apps.server_id) — never the bare column);
 *  - `selfUpdateServerAgent` is the infra seam and does NOT persist the version:
 *    call `markServerSeen` after, or the badge lags;
 *  - verify per server before moving on: Hello reports the target version, the
 *    capabilities we rely on are intact, and a DRY-RUN DockerCleanup answers —
 *    the live smoke test of the changed RPC.
 *
 * Run from /root/projects/deplo under REAL Node (never bun — its TLS SAN
 * handling breaks every mTLS dial):
 *
 *   /root/.nvm/versions/node/v24.18.0/bin/node --env-file=.env \
 *     --require ./lib/test/server-only-shim.cjs --import tsx \
 *     scripts/rollout-agent-1.12.mts
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { deployments, apps } from "../lib/db/schema/control-plane";
import { listAllServers, markServerSeen } from "../lib/data/servers";
import {
  agentPreflight,
  runAgentCleanup,
  selfUpdateServerAgent,
} from "../lib/infra/agent-client";
import { CleanupScope } from "../lib/agent/gen/agent";

const TARGET = "1.12.0";
/** Rollout order per the runbook: canary first, agent 0 (runs the control plane) last. */
const ORDER = [
  "srv_f47d8cba7db4c813", // neon-s1 (canary — fewest Apps)
  "srv_07b0be4ab9ef9533", // neon-s2 (the saturated host this fix is for)
  "srv_3667cf1973005952", // eu-main-1 (agent 0 — LAST)
];
/** Capabilities the control plane relies on; one disappearing = release regression. */
const REQUIRED_CAPS = ["self-update", "backup", "docker-cleanup", "container-stats"];

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
      `${name}: ${busy} in-flight deploy(s) — a self-update re-exec would kill their streams. Re-run later.`,
    );
  }

  console.log(`[${name}] updating…`);
  const { version } = await selfUpdateServerAgent(serverId);
  await markServerSeen(serverId, version);
  console.log(`[${name}] agent replied ${version}, waiting for the re-exec…`);
  // selfUpdateGrace is 750ms + exec + listen; give it a moment before Hello.
  await new Promise((r) => setTimeout(r, 4000));

  const hello = await agentPreflight(serverId);
  if (hello.agentVersion !== TARGET) {
    throw new Error(`${name}: Hello says ${hello.agentVersion}, want ${TARGET} — STOP the rollout`);
  }
  const missing = REQUIRED_CAPS.filter((c) => !hello.capabilities.includes(c));
  if (missing.length > 0) {
    throw new Error(`${name}: capabilities disappeared: ${missing.join(", ")} — STOP the rollout`);
  }
  await markServerSeen(serverId, hello.agentVersion);

  // Live smoke of the changed RPC: a dry run enumerates with the new rules and
  // must answer ok. (The owner just pruned the fleet by hand, so ~0 candidates
  // is the expected shape — the point is the RPC answering sanely, per scope.)
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
      console.log(`[${s.name}] not provisioned — skipping`);
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
