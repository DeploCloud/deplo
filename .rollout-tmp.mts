/**
 * Fleet agent update, one server per invocation.
 *
 * MUST run under real Node, never bun — bun's TLS SAN handling breaks every mTLS
 * dial to an agent. See docs/agents/fleet-rollout.md.
 *
 *   node --env-file=.env --require ./lib/test/server-only-shim.cjs --import tsx \
 *     <this file> <serverId>
 */
import {
  connectAgent,
  selfUpdateServerAgent,
} from "./lib/infra/agent-client";
import { markServerSeen } from "./lib/data/servers";

const serverId = process.argv[2];
if (!serverId) {
  console.error("usage: <serverId>");
  process.exit(1);
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function hello(label: string) {
  const conn = await connectAgent(serverId);
  try {
    const h = await conn.hello();
    console.log(
      `[${ts()}] ${label}: version=${h.agentVersion} docker=${h.dockerAvailable} ` +
        `traefik=${h.traefikRunning} metrics-stream=${h.capabilities?.includes("metrics-stream")}`,
    );
    return h;
  } finally {
    conn.close();
  }
}

const before = await hello("BEFORE");

console.log(`[${ts()}] updating ${serverId} ...`);
const version = await selfUpdateServerAgent(serverId);
console.log(`[${ts()}] selfUpdate returned: ${version}`);

// The agent syscall.Exec's itself ~750ms after replying, same PID. Give it a
// moment to come back before we probe, then retry — the socket is briefly gone.
let after = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    after = await hello(`AFTER (attempt ${i + 1})`);
    break;
  } catch (e) {
    console.log(`[${ts()}]   not back yet: ${(e as Error).message.slice(0, 80)}`);
  }
}
if (!after) {
  console.error(`[${ts()}] FAILED: agent did not come back`);
  process.exit(1);
}

// selfUpdateServerAgent does NOT persist agent_version — without this the badge
// lags until the health prober happens to self-correct.
await markServerSeen(serverId, after.agentVersion, after.traefikRunning, undefined, after.dockerVersion);
console.log(`[${ts()}] markServerSeen persisted version=${after.agentVersion}`);

if (before.agentVersion === after.agentVersion) {
  console.error(`[${ts()}] WARNING: version unchanged (${after.agentVersion})`);
  process.exit(1);
}
if (!after.capabilities?.includes("metrics-stream")) {
  console.error(`[${ts()}] FAILED: metrics-stream capability NOT advertised`);
  process.exit(1);
}
console.log(`[${ts()}] OK ${before.agentVersion} -> ${after.agentVersion}, metrics-stream present`);
process.exit(0);
