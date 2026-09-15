import { count, inArray, sql } from "drizzle-orm";

import { markServerSeen } from "../lib/data/servers/agent-handshake";
import { listAllServers } from "../lib/data/servers/roster";
import { getDb } from "../lib/db/client";
import { apps } from "../lib/db/schema/control-plane/apps";
import { deployments } from "../lib/db/schema/control-plane/deployments";
import { selfUpdateServerAgent } from "../lib/infra/agent-client/agent-lifecycle";
import {
  AgentUnreachableError,
  AgentUpdateUnsupportedError,
} from "../lib/infra/agent-client/errors";
import { agentPreflight } from "../lib/infra/agent-client/preflight";

const dryRun = process.argv.includes("--dry-run");
const localIp = process.env.DEPLO_SERVER_IP ?? "";
const only = argOf("--only");
const expectCapability = argOf("--expect");

function argOf(flag: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : "";
}

async function busyServerIds(): Promise<Set<string>> {
  const rows = await getDb()
    .select({
      serverId: sql<string>`coalesce(${deployments.serverId}, ${apps.serverId})`,
    })
    .from(deployments)
    .innerJoin(apps, sql`${apps.id} = ${deployments.appId}`)
    .where(inArray(deployments.status, ["queued", "building"]));
  return new Set(rows.map((r) => r.serverId).filter(Boolean));
}

async function appsPerServer(): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ serverId: apps.serverId, n: count() })
    .from(apps)
    .groupBy(apps.serverId);
  return new Map(rows.map((r) => [r.serverId ?? "", Number(r.n)]));
}

const all = await listAllServers();
const provisioned = all.filter(
  (s) => Boolean(s.agent?.certFingerprint) && !s.importOnly,
);
const load = await appsPerServer();
const remotes = provisioned
  .filter((s) => s.ip !== localIp)
  .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
const agentZero = provisioned.filter((s) => s.ip === localIp);
const order = [...remotes, ...agentZero].filter((s) => !only || s.id === only);

if (!order.length) {
  console.log("No provisioned servers, nothing to update.");
  process.exit(0);
}

const busy = await busyServerIds();
console.log(
  `Fleet: ${provisioned.length} provisioned (${remotes.length} remote, ${agentZero.length} local)` +
    `${dryRun ? "  [DRY RUN - no agent is touched]" : ""}`,
);

let updated = 0;
let skipped = 0;
for (const [i, s] of order.entries()) {
  const role =
    s.ip === localIp
      ? "agent 0 (control plane host)"
      : i === 0
        ? "canary"
        : "remote";
  const label = `${s.name} (${s.ip}, ${role}, ${load.get(s.id) ?? 0} apps)`;

  if (busy.has(s.id)) {
    console.log(
      `SKIP  ${label} - a deploy is in flight; an agent re-exec would drop it`,
    );
    skipped++;
    continue;
  }

  let before: string;
  try {
    before = (await agentPreflight(s.id)).agentVersion;
  } catch (e) {
    console.log(
      `SKIP  ${label} - unreachable before the update: ${(e as Error).message}`,
    );
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`WOULD ${label} - currently ${before}`);
    continue;
  }

  let target = "";
  try {
    const res = await selfUpdateServerAgent(s.id);
    target = res.version;
    console.log(
      `  ... ${label}: ${before} -> ${res.version} (restarting=${res.restarting})`,
    );
  } catch (e) {
    if (e instanceof AgentUpdateUnsupportedError) {
      console.log(
        `SKIP  ${label} - agent too old to self-update; re-run install-agent.sh there`,
      );
    } else if (e instanceof AgentUnreachableError) {
      console.log(`FAIL  ${label} - unreachable: ${e.message}`);
    } else {
      console.log(`FAIL  ${label} - ${(e as Error).message}`);
    }
    skipped++;
    console.log("Stopping: do not roll on past a failure.");
    break;
  }

  if (target && target === before && !expectCapability) {
    console.log(`OK    ${label} - already on ${before}`);
    continue;
  }

  let confirmed = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const h = await agentPreflight(s.id);
      if (
        expectCapability
          ? h.capabilities.includes(expectCapability)
          : h.agentVersion !== before
      ) {
        confirmed = h.agentVersion;
        await markServerSeen(
          s.id,
          h.agentVersion,
          h.traefikRunning,
          undefined,
          h.dockerVersion,
          h.hostArch,
        );
        console.log(
          `OK    ${label} - now ${h.agentVersion}, docker=${h.dockerAvailable}, caps=${h.capabilities.length}`,
        );
        break;
      }
    } catch {}
  }
  if (!confirmed) {
    console.log(
      `FAIL  ${label}, never came back ${expectCapability ? `advertising ${expectCapability}` : "on a new version"}. Stopping.`,
    );
    break;
  }
  updated++;
}

console.log(
  `\nDone: ${updated} updated, ${skipped} skipped/failed, ${order.length} considered.`,
);
process.exit(0);
