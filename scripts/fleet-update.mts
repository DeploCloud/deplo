/**
 * Roll the current GitHub `releases/latest` agent onto every provisioned server,
 * in the order docs/agents/fleet-rollout.md §4 requires.
 *
 *   node --env-file=.env --require ./lib/test/server-only-shim.cjs \
 *        --import tsx scripts/fleet-update.mts [--dry-run]
 *
 * REAL NODE, NEVER BUN: bun's TLS SAN handling rejects the agent certificate, so
 * every mTLS dial fails. `.mts` because a `.ts` compiles as CJS and rejects the
 * top-level await below.
 *
 * Ordering rules, and what breaks if you ignore them:
 *   - A REMOTE server goes first as the canary. If the new binary is bad, the
 *     control plane is still up to observe it and the blast radius is one host.
 *   - AGENT 0 (this host) goes LAST: it runs the control plane, so a bad agent
 *     there takes out the observer as well as the observed.
 *   - A server with an in-flight deploy is SKIPPED. The agent re-execs itself to
 *     apply the update, which drops the deploy stream mid-build.
 *
 * selfUpdateServerAgent does not persist agent_version, so markServerSeen runs
 * after each success — otherwise the "outdated" badge lags until the health
 * prober happens to re-check.
 */
import { inArray } from "drizzle-orm";

import { listAllServers, markServerSeen } from "../lib/data/servers";
import { getDb } from "../lib/db/client";
import { deployments } from "../lib/db/schema/control-plane";
import {
  agentPreflight,
  selfUpdateServerAgent,
  AgentUnreachableError,
  AgentUpdateUnsupportedError,
} from "../lib/infra/agent-client";

const dryRun = process.argv.includes("--dry-run");
const localIp = process.env.DEPLO_SERVER_IP ?? "";

/** Servers with a deploy the agent's re-exec would kill. */
async function busyServerIds(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ serverId: deployments.serverId })
    .from(deployments)
    .where(inArray(deployments.status, ["queued", "building"]));
  return new Set(rows.map((r) => r.serverId).filter((id): id is string => Boolean(id)));
}

const all = await listAllServers();
const provisioned = all.filter((s) => Boolean(s.agent?.certFingerprint));
const remotes = provisioned.filter((s) => s.ip !== localIp);
const agentZero = provisioned.filter((s) => s.ip === localIp);
// Canary first, then the other remotes, then this host.
const order = [...remotes, ...agentZero];

if (!order.length) {
  console.log("No provisioned servers — nothing to update.");
  process.exit(0);
}

const busy = await busyServerIds();
console.log(
  `Fleet: ${provisioned.length} provisioned (${remotes.length} remote, ${agentZero.length} local)` +
    `${dryRun ? "  [DRY RUN — no agent is touched]" : ""}`,
);

let updated = 0;
let skipped = 0;
for (const [i, s] of order.entries()) {
  const role = s.ip === localIp ? "agent 0 (control plane host)" : i === 0 ? "canary" : "remote";
  const label = `${s.name} (${s.ip}, ${role})`;

  if (busy.has(s.id)) {
    console.log(`SKIP  ${label} — a deploy is in flight; an agent re-exec would drop it`);
    skipped++;
    continue;
  }

  // Prove it answers, and record what it was on, BEFORE touching it.
  let before: string;
  try {
    before = (await agentPreflight(s.id)).agentVersion;
  } catch (e) {
    console.log(`SKIP  ${label} — unreachable before the update: ${(e as Error).message}`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`WOULD ${label} — currently ${before}`);
    continue;
  }

  try {
    const res = await selfUpdateServerAgent(s.id);
    console.log(`  ... ${label}: ${before} -> ${res.version} (restarting=${res.restarting})`);
  } catch (e) {
    if (e instanceof AgentUpdateUnsupportedError) {
      console.log(`SKIP  ${label} — agent too old to self-update; re-run install-agent.sh there`);
    } else if (e instanceof AgentUnreachableError) {
      console.log(`FAIL  ${label} — unreachable: ${e.message}`);
    } else {
      console.log(`FAIL  ${label} — ${(e as Error).message}`);
    }
    skipped++;
    console.log("Stopping: do not roll on past a failure.");
    break;
  }

  // The agent re-execs after replying; wait for the new binary to answer Hello
  // and CONFIRM the version, rather than trusting the response echo.
  let confirmed = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const h = await agentPreflight(s.id);
      if (h.agentVersion !== before) {
        confirmed = h.agentVersion;
        await markServerSeen(s.id, h.agentVersion, h.traefikRunning, undefined, h.dockerVersion);
        console.log(
          `OK    ${label} — now ${h.agentVersion}, docker=${h.dockerAvailable}, caps=${h.capabilities.length}`,
        );
        break;
      }
    } catch {
      // Expected while it re-execs; keep polling.
    }
  }
  if (!confirmed) {
    console.log(`FAIL  ${label} — never came back on a new version. Stopping.`);
    break;
  }
  updated++;
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped/failed, ${order.length} considered.`);
process.exit(0);
