/**
 * Canary soak. Holds ONE telemetry stream open for a long stretch and reports
 * anything that would show up as a chart hole.
 *
 * The specific thing this exists to catch: a gRPC keepalive mismatch. grpc-go's
 * server default MinTime is 5 MINUTES and answers a more frequent client ping
 * with GOAWAY/ENHANCE_YOUR_CALM. The agent sets an EnforcementPolicy of 15s and
 * the client pings every 30s — if either side of that pairing were wrong the
 * stream would die minutes in, which a two-minute smoke test would never see.
 */
import { connectMetricsStreamAgent } from "./lib/infra/agent-client";
import { GAP_MS } from "./lib/monitoring/chart-gaps";

const serverId = process.argv[2];
const minutes = Number(process.argv[3] ?? 35);
const until = Date.now() + minutes * 60_000;

function ts() {
  return new Date().toISOString().slice(11, 19);
}

let frames = 0;
let reconnects = 0;
let worstGap = 0;
let overGap = 0;
let prev = 0;
const errors: string[] = [];

console.log(`[${ts()}] soaking ${serverId} for ${minutes}min; GAP_MS=${GAP_MS}`);

while (Date.now() < until) {
  try {
    const { conn, hello } = await connectMetricsStreamAgent(serverId);
    console.log(`[${ts()}] connected (agent ${hello.agentVersion})${reconnects ? ` [reconnect #${reconnects}]` : ""}`);
    try {
      for await (const frame of conn.streamMetrics({
        dataDir: "",
        intervalMs: 5000,
        includeContainers: true,
      })) {
        const now = Date.now();
        if (prev) {
          const gap = now - prev;
          if (gap > worstGap) worstGap = gap;
          if (gap > GAP_MS) {
            overGap++;
            console.log(`[${ts()}] !! GAP ${gap}ms exceeds GAP_MS ${GAP_MS} — this would band the chart`);
          }
        }
        prev = now;
        frames++;
        if (frames % 60 === 0) {
          console.log(
            `[${ts()}] ${frames} frames, worst gap ${worstGap}ms, source=${frame.source}, ` +
              `${Math.round((until - now) / 60000)}min left`,
          );
        }
        if (Date.now() >= until) break;
      }
    } finally {
      conn.close();
    }
    if (Date.now() < until) {
      reconnects++;
      console.log(`[${ts()}] stream ended early (deadline rotation or drop); reconnecting`);
    }
  } catch (e) {
    reconnects++;
    const msg = (e as Error).message.slice(0, 120);
    errors.push(`${ts()} ${msg}`);
    console.log(`[${ts()}] ERROR: ${msg}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log("\n===== SOAK RESULT =====");
console.log(`frames:      ${frames}`);
console.log(`reconnects:  ${reconnects}`);
console.log(`worst gap:   ${worstGap}ms (GAP_MS=${GAP_MS})`);
console.log(`gaps over:   ${overGap}`);
console.log(`errors:      ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
const ok = overGap === 0 && errors.length === 0;
console.log(ok ? "VERDICT: PASS — no drops, no chart-visible gaps" : "VERDICT: FAIL");
process.exit(ok ? 0 : 1);
