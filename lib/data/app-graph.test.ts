import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  deploymentLogs,
  domains as domainsTable,
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  apps as appsTable,
  sharedEnvVarApps,
  teamAppOrder,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { __resetDeploymentLogBuffers } from "./deployment-logs";
import {
  listApps,
  reorderApps,
  deleteApp,
  createApp,
  summarizeForTeam,
} from "./apps";
import {
  addDomain,
  setPrimaryDomain,
  listDomains,
  ensureAutoDomain,
  ensureExtraDomain,
  uniqueAutoDomainName,
  routableRoutes,
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains";
import { loadDomainsForApp } from "./app-graph-load";
import { nipEmbeddedIp } from "../deploy/domains";
import { upsertEnv, listEnv } from "./env";
import { saveSharedVar, setSharedVarAppLink, listSharedVars } from "./shared-vars";

/**
 * Step 4 app-graph data-layer tests (relational-store PLAN §3 cut-set (c) /
 * §9 Step 4): the deleteApp CASCADE (no orphaned deployments/logs/env/
 * domains/shared-group attachments), the two-concurrent primary-domain race, the
 * ordering-junction reorder, and the cookie-free summary lookups the SSE
 * generator drives. Seeded relationally via the test-seed helpers.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // addDomain/updateDomain now check DNS at write time; stub the resolver so
  // the suite never hits the network. "Resolves nowhere" ⇒ every added custom
  // domain is born `pending`, the pre-check status these tests always assumed.
  __setDnsResolve4ForTest(async () => []);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  __resetDeploymentLogBuffers();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* deleteApp CASCADE — the orphan-bug fix                          */
/* ------------------------------------------------------------------ */

test("deleteApp cascades every child + shared-var link (no orphans)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedApp(db, { id: "prj_2", status: "active" });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1" });
  // A log line on prj_1's deployment.
  await db.insert(deploymentLogs).values({ deploymentId: "dpl_1", ts: "2026-01-01T00:00:00.000Z", level: "info", text: "x" });

  await asUser1(async () => {
    // An env var + a domain on prj_1.
    await upsertEnv({ appId: "prj_1", key: "K", value: "v", targets: ["production"], type: "plain" });
    await addDomain("prj_1", "app.example.io", {});
    // A shared var linked to BOTH apps (the orphan the old bug leaked).
    await saveSharedVar({
      key: "SHARED",
      value: "1",
      type: "plain",
      targets: ["production"],
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    });
    const varId = (await listSharedVars())[0]!.id;
    await setSharedVarAppLink(varId, "prj_1", true);
    await setSharedVarAppLink(varId, "prj_2", true);
    await deleteApp("prj_1");
  });

  // prj_1 and ALL its children are gone; prj_2 untouched.
  assert.equal((await db.select({ n: count() }).from(appsTable))[0]!.n, 1);
  assert.equal((await db.select({ n: count() }).from(deploymentsTable))[0]!.n, 0, "deployments cascade");
  assert.equal((await db.select({ n: count() }).from(deploymentLogs))[0]!.n, 0, "logs cascade");
  assert.equal((await db.select({ n: count() }).from(envVarsTable))[0]!.n, 0, "env vars cascade");
  assert.equal((await db.select({ n: count() }).from(envVarTargetsTable))[0]!.n, 0, "env targets cascade");
  assert.equal((await db.select({ n: count() }).from(domainsTable))[0]!.n, 0, "domains cascade");
  // The per-app link to prj_1 is GONE (cascaded); the prj_2 link survives.
  const links = await db.select().from(sharedEnvVarApps);
  assert.deepEqual(links.map((l) => l.appId), ["prj_2"], "dead link cascaded, live one kept");
});

/* ------------------------------------------------------------------ */
/* setPrimaryDomain — single-UPDATE flip + concurrent race            */
/* ------------------------------------------------------------------ */

test("setPrimaryDomain flips exactly one primary per project", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  let domBId = "";
  await asUser1(async () => {
    await addDomain("prj_1", "a.example.io", {}); // first ⇒ primary
    const b = await addDomain("prj_1", "b.example.io", {});
    domBId = b.id;
    await setPrimaryDomain(domBId);
    const list = await listDomains("prj_1");
    const primaries = list.filter((d) => d.primary);
    assert.equal(primaries.length, 1, "exactly one primary");
    assert.equal(primaries[0]!.id, domBId, "the chosen domain is primary");
  });
  // The partial-unique `(project_id) WHERE is_primary` holds at the DB level.
  const dbPrimaries = await db
    .select({ n: count() })
    .from(domainsTable)
    .where(eq(domainsTable.isPrimary, true));
  assert.equal(dbPrimaries[0]!.n, 1);
});

test("two concurrent setPrimaryDomain calls leave exactly one primary", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  let aId = "";
  let bId = "";
  await asUser1(async () => {
    const a = await addDomain("prj_1", "a.example.io", {});
    const b = await addDomain("prj_1", "b.example.io", {});
    aId = a.id;
    bId = b.id;
    // Fire both flips "concurrently" (pglite serializes on the event loop, but
    // the single-UPDATE + partial-unique guarantees a consistent end state).
    await Promise.all([setPrimaryDomain(aId), setPrimaryDomain(bId)]);
  });
  const primaries = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.isPrimary, true));
  assert.equal(primaries.length, 1, "exactly one primary survives the race");
});

/* ------------------------------------------------------------------ */
/* Ordering junction — reorderApps                                 */
/* ------------------------------------------------------------------ */

test("reorderApps writes the team_app_order junction; dead ids drop", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedApp(db, { id: "prj_2", status: "active" });
  await asUser1(async () => {
    // Reorder with a dead id ("ghost") that must be dropped.
    await reorderApps(["prj_2", "ghost", "prj_1"]);
  });
  const rows = await db
    .select()
    .from(teamAppOrder)
    .where(eq(teamAppOrder.teamId, TEAM_A))
    .orderBy(teamAppOrder.position);
  assert.deepEqual(rows.map((r) => [r.appId, r.position]), [
    ["prj_2", 0],
    ["prj_1", 1],
  ]);
  // listApps honours the manual order.
  await asUser1(async () => {
    const list = await listApps();
    assert.deepEqual(list.map((p) => p.id), ["prj_2", "prj_1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Cookie-free summary lookups (the SSE seam) + team scoping           */
/* ------------------------------------------------------------------ */

test("summarizeForTeam is cookie-free and team-scoped", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, status: "active" });
  // No runWithIdentity wrapper — proves it never reads a cookie/active team.
  const mine = await summarizeForTeam("prj_1", TEAM_A);
  assert.ok(mine, "found for the owning team");
  assert.equal(mine!.id, "prj_1");
  const other = await summarizeForTeam("prj_1", TEAM_B);
  assert.equal(other, null, "not visible to another team");
});

test("env vars + targets round-trip through the relational layer", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({
      appId: "prj_1",
      key: "API_KEY",
      value: "s3cret",
      targets: ["production", "preview"],
      type: "secret",
    });
    const list = await listEnv("prj_1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.masked, true, "secret is masked in the DTO");
    assert.deepEqual([...list[0]!.targets].sort(), ["preview", "production"]);
  });
  // The value is stored encrypted (not plaintext).
  const rows = await db.select().from(envVarsTable).where(eq(envVarsTable.appId, "prj_1"));
  assert.notEqual(rows[0]!.valueEnc, "s3cret");
});

test("an app env var records its author and defaults to every runtime", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    // No targets: the picker is gone from the UI (an App belongs to exactly ONE
    // Environment), so the var reaches every runtime.
    await upsertEnv({ appId: "prj_1", key: "K", value: "v", type: "plain" });
    const [v] = await listEnv("prj_1");
    assert.deepEqual([...v!.targets].sort(), ["preview", "production"]);
    assert.equal(v!.createdBy?.id, USER_1);
    assert.equal(v!.updatedBy?.id, USER_1);
    assert.equal(v!.createdBy?.username, USER_1);
  });
});

test("an edit that names no targets PRESERVES the stored ones", async () => {
  // The dialogs no longer send targets. A legacy production-only SECRET must not
  // silently widen to every runtime on a value rotation.
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({
      appId: "prj_1",
      key: "STRIPE",
      value: "live",
      targets: ["production"],
      type: "secret",
    });
    await upsertEnv({ appId: "prj_1", key: "STRIPE", value: "rotated", type: "secret" });
    const [v] = await listEnv("prj_1");
    assert.deepEqual(v!.targets, ["production"]);
    // An explicit set still replaces them.
    await upsertEnv({
      appId: "prj_1",
      key: "STRIPE",
      value: "rotated",
      targets: ["production", "preview"],
      type: "secret",
    });
    const [v2] = await listEnv("prj_1");
    assert.deepEqual([...v2!.targets].sort(), ["preview", "production"]);
  });
});

test("re-saving a secret with the MASK keeps its value (editing targets can't wipe it)", async () => {
  // The edit dialog prefills a secret's value with the MASK (you can't read back a
  // secret you didn't set). Without a keep-value contract, changing ONLY the
  // environments would silently overwrite the real value with the mask string.
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({
      appId: "prj_1",
      key: "API_KEY",
      value: "s3cret",
      targets: ["production"],
      type: "secret",
    });
    const before = await db
      .select()
      .from(envVarsTable)
      .where(eq(envVarsTable.appId, "prj_1"));
    // Re-save with the MASK sentinel and an extra target.
    await upsertEnv({
      appId: "prj_1",
      key: "API_KEY",
      value: "••••••••••••",
      targets: ["production", "preview"],
      type: "secret",
    });
    const after = await db
      .select()
      .from(envVarsTable)
      .where(eq(envVarsTable.appId, "prj_1"));
    assert.equal(after[0]!.valueEnc, before[0]!.valueEnc, "value preserved");
    const list = await listEnv("prj_1");
    assert.deepEqual([...list[0]!.targets].sort(), ["preview", "production"]);
  });
});

test("shared-var link attach/detach toggles the junction", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  let varId = "";
  await asUser1(async () => {
    await saveSharedVar({
      key: "X",
      value: "1",
      type: "plain",
      targets: ["production"],
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    });
    varId = (await listSharedVars())[0]!.id;
    await setSharedVarAppLink(varId, "prj_1", true);
  });
  assert.equal((await db.select({ n: count() }).from(sharedEnvVarApps))[0]!.n, 1);
  await asUser1(() => setSharedVarAppLink(varId, "prj_1", false));
  assert.equal((await db.select({ n: count() }).from(sharedEnvVarApps))[0]!.n, 0);
});

/* ------------------------------------------------------------------ */
/* createApp slug uniqueness under concurrency                     */
/* ------------------------------------------------------------------ */

test("two concurrent same-name createApp calls both succeed with distinct slugs", async () => {
  // createApp reads the server picklist from the relational `servers` table;
  // `beforeEach`'s `seedServer(db)` already seeded `srv_1`. "upload" source skips
  // the post-commit deploy (no agent dial), keeping the test hermetic.
  const input = {
    name: "My App",
    source: "upload" as const,
    repo: null,
  };
  const [a, b] = await asUser1(() =>
    Promise.all([createApp(input), createApp(input)]),
  );
  // Both persisted, with DISTINCT slugs (the second retried past the unique
  // violation onto the next free suffix).
  assert.notEqual(a.slug, b.slug, "concurrent same-name creates get distinct slugs");
  const rows = await db.select({ slug: appsTable.slug }).from(appsTable);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.slug)).size, 2, "two unique slugs persisted");
});

/* ------------------------------------------------------------------ */
/* Generated-domain uniqueness (no duplicate hostnames, globally)      */
/* ------------------------------------------------------------------ */

const IP = "1.2.3.4";

test("uniqueAutoDomainName never returns a host that already exists globally", async () => {
  await seedApp(db, { id: "prj_u", slug: "uniq" });
  // Pre-occupy 25 hosts under the same label+IP so generation must dodge them.
  const taken = new Set<string>();
  await asUser1(async () => {
    for (let i = 0; i < 25; i++) {
      const name = await uniqueAutoDomainName("uniq", IP);
      assert.ok(!taken.has(name), `generated a duplicate: ${name}`);
      taken.add(name);
      // Persist it so the NEXT call must avoid it too (global check).
      await ensureExtraDomain("prj_u", name, { port: 80, service: null, slug: "uniq", ip: IP });
    }
  });
  // Every persisted domain name is distinct.
  const rows = await loadDomainsForApp("prj_u");
  assert.equal(new Set(rows.map((d) => d.name)).size, rows.length);
  assert.equal(rows.length, 25);
});

test("ensureExtraDomain regenerates (not skips) when the template host collides with ANOTHER project", async () => {
  await seedApp(db, { id: "prj_a", slug: "alpha" });
  await seedApp(db, { id: "prj_b", slug: "beta" });
  // App A claims a host.
  const shared = `shared-charming-otter-${"01020304"}.nip.io`;
  await asUser1(() =>
    ensureExtraDomain("prj_a", shared, { port: 80, service: "web", slug: "alpha", ip: IP }),
  );
  // App B is handed the SAME host by its (hypothetical) template — it must
  // get a fresh unique host, NOT silently skip and NOT duplicate A's host.
  await asUser1(() =>
    ensureExtraDomain("prj_b", shared, { port: 80, service: "web", slug: "beta", ip: IP }),
  );
  const bDomains = await loadDomainsForApp("prj_b");
  assert.equal(bDomains.length, 1, "B got a domain (regenerated, not dropped)");
  assert.notEqual(bDomains[0].name, shared, "B did not reuse A's colliding host");
  assert.equal(nipEmbeddedIp(bDomains[0].name), IP, "B's host still encodes the IP");
  // A keeps the original; the two never share a name.
  const aDomains = await loadDomainsForApp("prj_a");
  assert.equal(aDomains[0].name, shared);
});

test("ensureExtraDomain is idempotent on the SAME project (re-run does not duplicate)", async () => {
  await seedApp(db, { id: "prj_c", slug: "gamma" });
  const host = `gamma-bold-lynx-${"01020304"}.nip.io`;
  await asUser1(async () => {
    await ensureExtraDomain("prj_c", host, { port: 80, service: "web", slug: "gamma", ip: IP });
    await ensureExtraDomain("prj_c", host, { port: 80, service: "web", slug: "gamma", ip: IP });
  });
  const rows = await loadDomainsForApp("prj_c");
  assert.equal(rows.length, 1, "the same host on the same project is not duplicated");
  assert.equal(rows[0].name, host);
});

test("ensureAutoDomain regenerates when its `preferred` host belongs to another project", async () => {
  await seedApp(db, { id: "prj_x", slug: "xeno" });
  await seedApp(db, { id: "prj_y", slug: "yeti" });
  const preferred = `pref-keen-puma-${"01020304"}.nip.io`;
  // X claims `preferred` as its primary.
  const xName = await asUser1(() =>
    ensureAutoDomain("prj_x", { slug: "xeno", ip: IP, preferred, defaultPort: 80 }),
  );
  assert.equal(xName, preferred);
  // Y is given the SAME preferred — it must regenerate a distinct primary.
  const yName = await asUser1(() =>
    ensureAutoDomain("prj_y", { slug: "yeti", ip: IP, preferred, defaultPort: 80 }),
  );
  assert.notEqual(yName, preferred, "Y regenerated rather than colliding");
  assert.equal(nipEmbeddedIp(yName), IP);
});

/* ------------------------------------------------------------------ */
/* Path-routed domains — a hostname carries one row per path          */
/* ------------------------------------------------------------------ */

/**
 * `pathPrefix` lets several rows share ONE hostname (`app.com` for `/`, `app.com`
 * for `/api`), which is the whole point of the "Internal path" option. Two things
 * used to silently kill it in the data layer:
 *
 *  1. the new row was inserted `pending`, and `routableRoutes` only routes
 *     `valid`/`cloudflare` — so the path row was filtered off the router even
 *     though its hostname's DNS was already proven by the sibling row. DNS is a
 *     property of the HOSTNAME, not of the path;
 *  2. the row's `pathPrefix`/`stripPrefix` had to survive the round trip into the
 *     route the router grammar is rendered from.
 */

test("a path row on an already-verified hostname inherits its DNS status (and routes)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    // ensureAutoDomain inserts a `valid` row — the verified sibling.
    const auto = await ensureAutoDomain("prj_1", {
      slug: "app",
      ip: "1.2.3.4",
      defaultPort: 80,
    });
    // A SECOND row on the same hostname, path-routed to another port.
    const api = await addDomain("prj_1", auto, {
      port: 8080,
      pathPrefix: "/api",
      stripPrefix: true,
    });
    assert.equal(
      api.status,
      "valid",
      "same hostname, already-proven DNS ⇒ routable immediately, not stuck pending",
    );

    // Both rows reach the router, and the path row keeps its full config.
    const routes = await routableRoutes("prj_1");
    assert.equal(routes.length, 2, "both the whole-host and the /api row route");
    const path = routes.find((r) => r.pathPrefix === "/api");
    assert.ok(path, "the /api route must be present");
    assert.equal(path.stripPrefix, true);
    assert.equal(path.port, 8080);
    assert.equal(path.name, auto);
  });
});

test("a path row on an UNVERIFIED hostname stays pending (DNS is still unproven)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    // No verified sibling for this hostname ⇒ the DNS really is unchecked.
    const d = await addDomain("prj_1", "fresh.example.io", { pathPrefix: "/api" });
    assert.equal(d.status, "pending");
    assert.deepEqual(await routableRoutes("prj_1"), [], "unproven host is not routed");
  });
});

/* ------------------------------------------------------------------ */
/* Certificate defaults — no cert is registered unless opted in        */
/* ------------------------------------------------------------------ */

test("addDomain without a certProvider is born WITHOUT a certificate (`none`)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    const plain = await addDomain("prj_1", "plain.example.io", {});
    assert.equal(plain.certProvider, "none", "omitted provider ⇒ no certificate");
    // An explicit choice is stored verbatim — opting in still works.
    const secure = await addDomain("prj_1", "secure.example.io", {
      certProvider: "letsencrypt",
    });
    assert.equal(secure.certProvider, "letsencrypt");
  });
});

test("auto domains are born plain-HTTP unless the blueprint opted into TLS", async () => {
  await seedApp(db, { id: "prj_1", slug: "plain" });
  await seedApp(db, { id: "prj_2", slug: "tls" });
  await asUser1(async () => {
    // No TLS choice (a wizard app / template with no https URLs) ⇒ `none`.
    await ensureAutoDomain("prj_1", { slug: "plain", ip: IP, defaultPort: 80 });
    // A blueprint that expects HTTPS passes letsencrypt for ALL its hosts.
    await ensureAutoDomain("prj_2", {
      slug: "tls",
      ip: IP,
      defaultPort: 80,
      certProvider: "letsencrypt",
    });
    await ensureExtraDomain("prj_2", "tls-extra-keen-owl-01020304.nip.io", {
      port: 81,
      service: "web",
      slug: "tls",
      ip: IP,
      certProvider: "letsencrypt",
    });
  });
  const plain = await loadDomainsForApp("prj_1");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].certProvider, "none", "stored explicitly, not left absent");
  assert.equal(plain[0].ssl, false, "ssl mirrors the cert-less birth");
  const tls = await loadDomainsForApp("prj_2");
  assert.equal(tls.length, 2);
  for (const d of tls) {
    assert.equal(d.certProvider, "letsencrypt");
    assert.equal(d.ssl, true);
  }
});
