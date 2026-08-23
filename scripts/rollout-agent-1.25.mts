/**
 * Fleet rollout of deplo-agent v1.25.0 - per-app image retention
 * (`DockerCleanupRequest.keep_per_slug`), which is what carries each App's
 * rollback depth to the host that enforces it.
 *
 * Follows docs/agents/fleet-rollout.md to the letter:
 *  - order: canary (fewest Apps) -> the other remote -> agent 0 (the control
 *    plane's own host) LAST;
 *  - skip any server with an in-flight deploy (queued/building, resolved through
 *    coalesce(deployments.server_id, apps.server_id) - never the bare column,
 *    which is nullable and would make a live deploy invisible);
 *  - `selfUpdateServerAgent` does NOT persist the version, so `markServerSeen`
 *    runs after each success or the "outdated" badge lags;
 *  - verify per server before moving on.
 *
 * The verification here is §7's side-by-side, and this release is exactly the
 * case §7 exists for: a NEW retention path replacing an old one, where both are
 * individually correct and only a comparison on real data shows they disagree.
 * Per host it dry-runs UNUSED_APP_IMAGES three ways and prints all three:
 *
 *   A  scalar-1        what the sweep removes today (the shipped default)
 *   B  per-slug        what it removes once each App's rollback depth applies
 *   C  raised scalar   the fallback the control plane sends an OLD agent
 *
 * B must be a SUBSET of A: per-app retention may only ever protect more images,
 * never delete one the old rule kept. C must be a subset of A for the same
 * reason. Nothing is removed - every probe is `dry_run`.
 *
 * Run from /root/projects/deplo under REAL Node (never bun - its TLS SAN
 * handling rejects the agent certificate and every mTLS dial fails):
 *
 *   node --require ./lib/test/server-only-shim.cjs --import tsx \
 *     scripts/rollout-agent-1.25.mts [--probe-only]
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

const TARGET = "1.25.0";
const KEEP_PER_SLUG_CAP = "cleanup.keep-per-slug";
/** Capabilities the control plane relies on; one disappearing = a regression. */
const REQUIRED_CAPS = ["self-update", "backup", "docker-cleanup", "container-stats"];
/** Probe without touching any agent binary (the BEFORE half of §7). */
const probeOnly = process.argv.includes("--probe-only");
/**
 * `--only <name>` stops after that one server. §4's ordering is not a formality:
 * the canary is updated and verified on its own - including a real deploy, which
 * is the check a re-exec actually threatens - before anything else is touched.
 */
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : process.argv[i + 1];
})();

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

/** The map the sweep really sends for this host: rollback depth + the live one. */
async function keepPerSlugFor(serverId: string): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ slug: apps.slug, keep: apps.rollbackKeep })
    .from(apps)
    .where(eq(apps.serverId, serverId));
  const out: Record<string, number> = {};
  for (const r of rows) out[r.slug] = Math.max(1, r.keep + 1);
  return out;
}

async function dryRunImages(
  serverId: string,
  keepImagesPerApp: number,
  keepPerSlug: Record<string, number>,
): Promise<{ ids: Set<string>; count: number; bytes: number }> {
  const resp = await runAgentCleanup(serverId, {
    scopes: [CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES],
    dryRun: true,
    minAgeHours: 24,
    keepImagesPerApp,
    keepPerSlug,
    // Images only: this dry run asks for no scope that reads the inventory.
    liveSlugs: [],
  });
  if (!resp.ok) throw new Error(`dry-run cleanup failed: ${resp.error}`);
  const r = (resp.results ?? [])[0];
  return {
    ids: new Set(r?.items ?? []),
    count: r?.itemsRemoved ?? 0,
    bytes: Number(r?.reclaimedBytes ?? 0),
  };
}

/** §7: the three retention shapes on one host, compared. */
async function probe(serverId: string, name: string): Promise<void> {
  const hello = await agentPreflight(serverId);
  const map = await keepPerSlugFor(serverId);
  const capable = hello.capabilities.includes(KEEP_PER_SLUG_CAP);
  const raised = Math.max(1, ...Object.values(map), 1);
  console.log(
    `[${name}] agent=v${hello.agentVersion} ${KEEP_PER_SLUG_CAP}=${capable} apps=${Object.keys(map).length}`,
  );

  const a = await dryRunImages(serverId, 1, {});
  const b = await dryRunImages(serverId, 1, map);
  const c = await dryRunImages(serverId, raised, {});
  console.log(`[${name}]   A scalar-1        would remove ${a.count} (${a.bytes} B)`);
  console.log(`[${name}]   B per-slug        would remove ${b.count} (${b.bytes} B)`);
  console.log(`[${name}]   C raised scalar=${raised}  would remove ${c.count} (${c.bytes} B)`);

  // Only meaningful once the agent reads the map; before the update B == A by
  // construction (the field is ignored), which is itself worth seeing printed.
  const subsetB = [...b.ids].every((x) => a.ids.has(x));
  const subsetC = [...c.ids].every((x) => a.ids.has(x));
  console.log(
    `[${name}]   protected_by_map=${a.count - b.count} B_subset_of_A=${subsetB} C_subset_of_A=${subsetC}`,
  );
  if (!subsetB || !subsetC) {
    throw new Error(
      `${name}: retention would remove an image the old rule KEPT - STOP the rollout`,
    );
  }
  if (capable && b.count > a.count) {
    throw new Error(`${name}: per-slug removes MORE than scalar-1 - STOP the rollout`);
  }
}

async function updateOne(serverId: string, name: string): Promise<void> {
  const busy = await inFlightDeploys(serverId);
  if (busy > 0) {
    throw new Error(
      `${name}: ${busy} in-flight deploy(s) - a self-update re-exec would kill their streams. Re-run later.`,
    );
  }

  console.log(`[${name}] updating`);
  const { version } = await selfUpdateServerAgent(serverId);
  await markServerSeen(serverId, version);
  console.log(`[${name}] agent replied ${version}, waiting for the re-exec`);
  await new Promise((r) => setTimeout(r, 4000));

  const hello = await agentPreflight(serverId);
  if (hello.agentVersion !== TARGET) {
    throw new Error(`${name}: Hello says ${hello.agentVersion}, want ${TARGET} - STOP the rollout`);
  }
  const missing = REQUIRED_CAPS.filter((c) => !hello.capabilities.includes(c));
  if (missing.length > 0) {
    throw new Error(`${name}: capabilities disappeared: ${missing.join(", ")} - STOP the rollout`);
  }
  if (!hello.capabilities.includes(KEEP_PER_SLUG_CAP)) {
    throw new Error(`${name}: on ${TARGET} but not advertising ${KEEP_PER_SLUG_CAP} - STOP`);
  }
  await markServerSeen(serverId, hello.agentVersion, hello.traefikRunning);
  console.log(`[${name}] OK on ${hello.agentVersion}, docker=${hello.dockerAvailable}`);
}

async function main(): Promise<void> {
  const local = process.env.DEPLO_SERVER_IP ?? "";
  const servers = (await listAllServers()).filter((s) => Boolean(s.agent?.certFingerprint));
  // Canary = the remote with the fewest Apps: if the binary is bad the control
  // plane is still up to observe it and the blast radius is one host.
  const counts = new Map<string, number>();
  for (const row of await getDb().select({ serverId: apps.serverId }).from(apps)) {
    if (row.serverId) counts.set(row.serverId, (counts.get(row.serverId) ?? 0) + 1);
  }
  const remotes = servers
    .filter((s) => s.ip !== local)
    .sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0));
  const order = [...remotes, ...servers.filter((s) => s.ip === local)];

  for (const [i, s] of order.entries()) {
    const role = s.ip === local ? "agent 0" : i === 0 ? "canary" : "remote";
    if (only && s.name !== only) continue;
    console.log(`--- ${s.name} (${s.ip}, ${role}, ${counts.get(s.id) ?? 0} apps)`);
    if (probeOnly) {
      await probe(s.id, s.name);
      continue;
    }
    await updateOne(s.id, s.name);
    await probe(s.id, s.name);
  }
  console.log(probeOnly ? "probe complete" : `fleet on ${TARGET}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
