/**
 * Roll a LOCALLY BUILT agent binary onto the remote fleet, for the window where
 * the fix exists but the GitHub release does not yet. A server with a deploy in
 * flight is skipped, because the agent re-execs to apply the update.
 */
import { inArray } from "drizzle-orm";

import { listAllServers, markServerSeen } from "../lib/data/servers";
import { getDb } from "../lib/db/client";
import { deployments } from "../lib/db/schema/control-plane";
import { agentPreflight, connectAgent } from "../lib/infra/agent-client";

const [version, baseUrl] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!version || !baseUrl) {
  console.error(
    "usage: fleet-update-manual.mts <version> <base-url> [--dry-run]",
  );
  process.exit(1);
}

/** Read `sha256  filename` lines and index them by arch. */
async function resolveBinaries(): Promise<
  Record<string, { url: string; sha256: string }>
> {
  const res = await fetch(`${baseUrl}/checksums.txt`);
  if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`);
  const out: Record<string, { url: string; sha256: string }> = {};
  for (const line of (await res.text()).split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (!sha || !name) continue;
    const arch = name.endsWith("amd64")
      ? "amd64"
      : name.endsWith("arm64")
        ? "arm64"
        : "";
    if (arch) out[arch] = { url: `${baseUrl}/${name}`, sha256: sha };
  }
  if (!out.amd64 && !out.arm64)
    throw new Error("no per-arch binaries in checksums.txt");
  return out;
}

async function busyServerIds(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ serverId: deployments.serverId })
    .from(deployments)
    .where(inArray(deployments.status, ["queued", "building"]));
  return new Set(
    rows.map((r) => r.serverId).filter((id): id is string => Boolean(id)),
  );
}

const binaries = await resolveBinaries();
console.log(`Target v${version} from ${baseUrl}`);
for (const [arch, b] of Object.entries(binaries))
  console.log(`  ${arch}  ${b.sha256}`);

const localIp = process.env.DEPLO_SERVER_IP ?? "";
const provisioned = (await listAllServers()).filter((s) =>
  Boolean(s.agent?.certFingerprint),
);
const remotes = provisioned.filter((s) => s.ip !== localIp);
if (!remotes.length) {
  console.log("No remote servers, nothing to do.");
  process.exit(0);
}
const busy = await busyServerIds();
console.log(
  `Fleet: ${provisioned.length} provisioned, ${remotes.length} remote to roll` +
    `${dryRun ? "  [DRY RUN - no agent is touched]" : ""}`,
);

let updated = 0;
for (const [i, s] of remotes.entries()) {
  const label = `${s.name} (${s.ip}, ${i === 0 ? "canary" : "remote"})`;
  if (busy.has(s.id)) {
    console.log(
      `SKIP  ${label} - a deploy is in flight; an agent re-exec would drop it`,
    );
    continue;
  }

  let before: string;
  try {
    before = (await agentPreflight(s.id)).agentVersion;
  } catch (e) {
    console.log(
      `SKIP  ${label} - unreachable before the update: ${(e as Error).message}`,
    );
    continue;
  }
  if (dryRun) {
    console.log(`WOULD ${label} - currently ${before}`);
    continue;
  }

  const conn = await connectAgent(s.id);
  try {
    const res = await conn.selfUpdate(version, binaries);
    console.log(
      `  ... ${label}: ${before} -> ${res.version} (restarting=${res.restarting})`,
    );
  } catch (e) {
    console.log(`FAIL  ${label} - ${(e as Error).message}`);
    console.log("Stopping: do not roll on past a failure.");
    conn.close();
    break;
  } finally {
    conn.close();
  }

  // Trust Hello, not the response echo: the agent re-execs after replying.
  let confirmed = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const h = await agentPreflight(s.id);
      if (h.agentVersion !== before) {
        confirmed = h.agentVersion;
        await markServerSeen(
          s.id,
          h.agentVersion,
          h.traefikRunning,
          undefined,
          h.dockerVersion,
        );
        console.log(
          `OK    ${label} - now ${h.agentVersion}, docker=${h.dockerAvailable}, caps=${h.capabilities.length}`,
        );
        break;
      }
    } catch {
      // Still re-execing; keep waiting.
    }
  }
  if (!confirmed) {
    console.log(`FAIL  ${label}, never came back on a new version. Stopping.`);
    break;
  }
  updated++;
}

console.log(
  `\n${updated}/${remotes.length} remote server(s) now on v${version}.`,
);
process.exit(0);
