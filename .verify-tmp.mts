/**
 * End-to-end verification of an updated agent, over real mTLS.
 * Proves BOTH paths: the unary RPCs the currently-running control plane still
 * uses, and the new telemetry stream.
 */
import { connectAgent, connectMetricsStreamAgent } from "./lib/infra/agent-client";

const serverId = process.argv[2];
const frameCount = Number(process.argv[3] ?? 4);

function ts() {
  return new Date().toISOString().slice(11, 19);
}

// --- 1. BACKWARD COMPATIBILITY: the unary path the live control plane uses ---
{
  const conn = await connectAgent(serverId);
  try {
    const t0 = Date.now();
    const m = await conn.metrics("");
    console.log(
      `[${ts()}] unary Metrics OK in ${Date.now() - t0}ms: cpu=${m.cpu}% ` +
        `cores=${m.cpuCores} mem=${(Number(m.memUsed) / 2 ** 30).toFixed(1)}/${(Number(m.memTotal) / 2 ** 30).toFixed(1)}GiB ` +
        `containers=${m.runningContainers}`,
    );
  } finally {
    conn.close();
  }
}

// --- 2. THE NEW PATH: one long-lived stream ---
const { conn, hello } = await connectMetricsStreamAgent(serverId);
console.log(`[${ts()}] stream connected; agent=${hello.agentVersion}`);

let n = 0;
let prev = 0;
try {
  for await (const frame of conn.streamMetrics({
    dataDir: "",
    intervalMs: 5000,
    includeContainers: true,
  })) {
    const now = Date.now();
    const spacing = prev ? `${now - prev}ms` : "first";
    prev = now;
    const labelled = frame.containers.filter((c) => c.projectId).length;
    const projects = new Set(frame.containers.map((c) => c.projectId).filter(Boolean));
    console.log(
      `[${ts()}] frame ${++n} (+${spacing}) source=${frame.source} ` +
        `host.cpu=${frame.host?.cpu}% host.containers=${frame.host?.runningContainers} ` +
        `stats=${frame.containers.length} labelled=${labelled} projects=${projects.size}`,
    );
    if (n === 1 && frame.containers.length > 0) {
      const c = frame.containers[0];
      console.log(
        `        sample container: name=${c.name} project=${c.projectId || "(none)"} ` +
          `id=${c.containerId.slice(0, 12)} state=${c.state} health=${c.health || "(none)"} ` +
          `restarts=${c.restartCount} cpu=${c.cpuPct}% mem=${(Number(c.memUsed) / 2 ** 20).toFixed(0)}MiB pids=${c.pids}`,
      );
    }
    if (n >= frameCount) break;
  }
} finally {
  conn.close();
}
console.log(`[${ts()}] stream closed cleanly after ${n} frames`);
process.exit(0);
