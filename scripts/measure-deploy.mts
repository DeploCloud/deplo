/**
 * Trigger one deployment of an app and report where its time went, straight from
 * deployment_logs. Used to measure build-pipeline changes against a real app on a
 * real host rather than a synthetic benchmark.
 *
 *   node --env-file=.env --require ./lib/test/server-only-shim.cjs \
 *        --import tsx scripts/measure-deploy.mts <app-slug>
 */
import { desc, eq, asc } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { apps, deployments, deploymentLogs } from "../lib/db/schema/control-plane";
import { startDeployment } from "../lib/deploy/build";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: measure-deploy.mts <app-slug>");
  process.exit(1);
}

const db = getDb();
const [app] = await db.select().from(apps).where(eq(apps.slug, slug)).limit(1);
if (!app) {
  console.error(`no app with slug ${slug}`);
  process.exit(1);
}
console.log(`Deploying ${app.name} (${app.slug}) on server ${app.serverId}…`);

const depId = await startDeployment(app.id, { creator: "measure-deploy" });
console.log(`deployment ${depId}`);

// Poll until it leaves the running states.
const started = Date.now();
let status = "queued";
while (Date.now() - started < 20 * 60_000) {
  await new Promise((r) => setTimeout(r, 3000));
  const [row] = await db
    .select({ status: deployments.status })
    .from(deployments)
    .where(eq(deployments.id, depId))
    .limit(1);
  status = row?.status ?? "?";
  if (status !== "queued" && status !== "building") break;
}

const [dep] = await db
  .select()
  .from(deployments)
  .where(eq(deployments.id, depId))
  .limit(1);
console.log(`\nstatus=${dep?.status}  total=${((dep?.buildDurationMs ?? 0) / 1000).toFixed(1)}s`);

// Where the time went: every BuildKit "#N ... DONE Xs" plus our own phase lines.
const logs = await db
  .select({ ts: deploymentLogs.ts, text: deploymentLogs.text })
  .from(deploymentLogs)
  .where(eq(deploymentLogs.deploymentId, depId))
  .orderBy(asc(deploymentLogs.id));

console.log("\n--- steps ---");
for (const l of logs) {
  const t = String(l.text);
  if (
    /#\d+ .*(DONE \d|CACHED)/.test(t) ||
    /exporting layers|unpacking to|naming to/.test(t) ||
    /^(git clone|docker |nixpacks |railpack |buildctl)/.test(t) ||
    /Checked out|Waiting for|Deployment ready|error/i.test(t)
  ) {
    console.log(`${new Date(l.ts as unknown as string).toISOString().slice(11, 19)}  ${t.slice(0, 150)}`);
  }
}

// Recent history for the same app, so a change is visible as a trend.
const recent = await db
  .select({ id: deployments.id, status: deployments.status, ms: deployments.buildDurationMs })
  .from(deployments)
  .where(eq(deployments.appId, app.id))
  .orderBy(desc(deployments.createdAt))
  .limit(8);
console.log("\n--- recent deploys (newest first) ---");
for (const r of recent) {
  console.log(`${r.id}  ${String(r.status).padEnd(8)}  ${((r.ms ?? 0) / 1000).toFixed(1)}s`);
}
process.exit(0);
