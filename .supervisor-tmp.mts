/**
 * End-to-end check of the CONTROL-PLANE half against the real fleet, in a
 * throwaway process — the running :3000 is not touched.
 *
 * The supervisor's own tests drive it through a fake connector. This runs the
 * real thing against real agents over real mTLS and then reads the ring buffers,
 * which is the only way to know the demux actually lands samples where the
 * charts read them from.
 */
import {
  startMetricsStreams,
  stopMetricsStreams,
  __streamModes,
} from "./lib/monitoring/supervisor";
import { getMetricsHistory } from "./lib/monitoring/history";
import { getContainerHistory, latestContainerInstances } from "./lib/monitoring/container-history";
import { listAllServers } from "./lib/data/servers";

const seconds = Number(process.argv[2] ?? 45);
const ts = () => new Date().toISOString().slice(11, 19);

const servers = await listAllServers();
console.log(`[${ts()}] fleet: ${servers.map((s) => `${s.name}@${s.agent?.version ?? "?"}`).join(", ")}`);

startMetricsStreams();
console.log(`[${ts()}] supervisor started; collecting for ${seconds}s`);

await new Promise((r) => setTimeout(r, seconds * 1000));

console.log(`\n[${ts()}] modes: ${JSON.stringify(__streamModes())}`);

let totalHost = 0;
for (const s of servers) {
  const h = getMetricsHistory(s.id);
  totalHost += h.length;
  const gaps: number[] = [];
  for (let i = 1; i < h.length; i++) gaps.push(h[i].ts - h[i - 1].ts);
  const worst = gaps.length ? Math.max(...gaps) : 0;
  console.log(
    `  ${s.name.padEnd(12)} host samples=${String(h.length).padStart(3)} worst gap=${worst}ms ` +
      `latest cpu=${h.at(-1)?.cpu ?? "-"}% containers=${h.at(-1)?.containers ?? "-"}`,
  );
}

// The demux: did any App/Database buffer fill? Ids come from what actually
// arrived, so this proves the deplo.project label round-tripped.
const { getDb } = await import("./lib/db/client");
const { apps } = await import("./lib/db/schema/control-plane");
const rows = await getDb().select({ id: apps.id, name: apps.name }).from(apps).limit(200);
let filled = 0;
for (const a of rows) {
  const buf = getContainerHistory(a.id);
  if (buf.length === 0) continue;
  filled++;
  if (filled <= 5) {
    const inst = latestContainerInstances(a.id);
    console.log(
      `  app ${a.name.padEnd(18)} samples=${String(buf.length).padStart(3)} ` +
        `cpu=${buf.at(-1)?.cpu.toFixed(1)}% mem=${((buf.at(-1)?.memUsed ?? 0) / 2 ** 20).toFixed(0)}MiB ` +
        `running=${buf.at(-1)?.running}/${buf.at(-1)?.containers} instances=${inst.length}`,
    );
  }
}
console.log(`\n[${ts()}] host samples total=${totalHost}; apps with a filled buffer=${filled}`);

await stopMetricsStreams();
console.log(`[${ts()}] supervisor stopped cleanly`);

const ok = totalHost > 0 && filled > 0;
console.log(ok ? "VERDICT: PASS" : "VERDICT: FAIL — buffers did not fill");
process.exit(ok ? 0 : 1);
