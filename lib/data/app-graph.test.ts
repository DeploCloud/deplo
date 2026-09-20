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
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  deployments as deploymentsTable,
  deploymentLogs,
} from "../db/schema/control-plane/deployments";
import { teamAppOrder } from "../db/schema/control-plane/display-order";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  sharedEnvVarApps,
} from "../db/schema/control-plane/env-vars";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { __resetDeploymentLogBuffers } from "./deployment-logs";
import { createApp } from "./apps/create";
import { deleteApp, deleteApps, resumeAppDeletes } from "./apps/delete";
import { listApps, reorderApps, summarizeForTeam } from "./apps/listing";
import { renameApp } from "./apps/settings";
import { ensureAutoDomain, ensureExtraDomain } from "./domains/auto-domains";
import { addDomain, listDomains } from "./domains/crud";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import { uniqueAutoDomainName } from "./domains/hostname-claim";
import { setPrimaryDomain } from "./domains/primary-domain";
import { routableRoutes } from "./domains/routes";
import { loadDomainsForApp } from "./app-graph-load";
import { wildcardDomain, wildcardEmbeddedIp } from "../deploy/domains";
import { upsertEnv, listEnv } from "./env";
import { setSharedVarAppLink } from "./shared-vars/app-links";
import { saveSharedVar } from "./shared-vars/authoring";
import { listSharedVars } from "./shared-vars/team-view";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
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

test("deleteApp cascades every child + shared-var link (no orphans)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedApp(db, { id: "prj_2", status: "active" });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1" });
  await db.insert(deploymentLogs).values({
    deploymentId: "dpl_1",
    ts: "2026-01-01T00:00:00.000Z",
    level: "info",
    text: "x",
  });

  await asUser1(async () => {
    await upsertEnv({
      appId: "prj_1",
      key: "K",
      value: "v",
      targets: ["production"],
      type: "plain",
    });
    await addDomain("prj_1", "app.example.io", {});
    await saveSharedVar({
      key: "SHARED",
      value: "1",
      type: "plain",
      targets: ["production"],
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    });
    const varId = (await listSharedVars())[0]!.id;
    await setSharedVarAppLink(varId, "prj_1", true);
    await setSharedVarAppLink(varId, "prj_2", true);
    await deleteApp("prj_1");
  });

  assert.equal((await db.select({ n: count() }).from(appsTable))[0]!.n, 1);
  assert.equal(
    (await db.select({ n: count() }).from(deploymentsTable))[0]!.n,
    0,
    "deployments cascade",
  );
  assert.equal(
    (await db.select({ n: count() }).from(deploymentLogs))[0]!.n,
    0,
    "logs cascade",
  );
  assert.equal(
    (await db.select({ n: count() }).from(envVarsTable))[0]!.n,
    0,
    "env vars cascade",
  );
  assert.equal(
    (await db.select({ n: count() }).from(envVarTargetsTable))[0]!.n,
    0,
    "env targets cascade",
  );
  assert.equal(
    (await db.select({ n: count() }).from(domainsTable))[0]!.n,
    0,
    "domains cascade",
  );
  const links = await db.select().from(sharedEnvVarApps);
  assert.deepEqual(
    links.map((l) => l.appId),
    ["prj_2"],
    "dead link cascaded, live one kept",
  );
});

test("an app being deleted is locked, unlisted, and finished at boot", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedApp(db, { id: "prj_2", status: "active" });
  await db
    .update(appsTable)
    .set({ deletingAt: "2026-08-12T00:00:00.000Z" })
    .where(eq(appsTable.id, "prj_1"));

  await asUser1(async () => {
    await assert.rejects(
      () => renameApp("prj_1", "Second thoughts"),
      /being deleted/,
      "a stamped app refuses every mutation",
    );
    await assert.rejects(
      () => deleteApp("prj_1"),
      /being deleted/,
      "including a second delete",
    );
    const listed = await listApps();
    assert.deepEqual(
      listed.map((p) => p.id),
      ["prj_2"],
    );
    assert.equal(await deleteApps(["prj_1", "prj_2"]), 1);
  });

  await resumeAppDeletes();
  assert.equal((await db.select({ n: count() }).from(appsTable))[0]!.n, 0);
});

test("setPrimaryDomain flips exactly one primary per project", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  let domBId = "";
  await asUser1(async () => {
    await addDomain("prj_1", "a.example.io", {});
    const b = await addDomain("prj_1", "b.example.io", {});
    domBId = b.id;
    await setPrimaryDomain(domBId);
    const list = await listDomains("prj_1");
    const primaries = list.filter((d) => d.primary);
    assert.equal(primaries.length, 1, "exactly one primary");
    assert.equal(primaries[0]!.id, domBId, "the chosen domain is primary");
  });
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
    await Promise.all([setPrimaryDomain(aId), setPrimaryDomain(bId)]);
  });
  const primaries = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.isPrimary, true));
  assert.equal(primaries.length, 1, "exactly one primary survives the race");
});

test("reorderApps writes the team_app_order junction; dead ids drop", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedApp(db, { id: "prj_2", status: "active" });
  await asUser1(async () => {
    await reorderApps(["prj_2", "ghost", "prj_1"]);
  });
  const rows = await db
    .select()
    .from(teamAppOrder)
    .where(eq(teamAppOrder.teamId, TEAM_A))
    .orderBy(teamAppOrder.position);
  assert.deepEqual(
    rows.map((r) => [r.appId, r.position]),
    [
      ["prj_2", 0],
      ["prj_1", 1],
    ],
  );
  await asUser1(async () => {
    const list = await listApps();
    assert.deepEqual(
      list.map((p) => p.id),
      ["prj_2", "prj_1"],
    );
  });
});

test("summarizeForTeam is cookie-free and team-scoped", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, status: "active" });
  const mine = await summarizeForTeam("prj_1", TEAM_A, USER_1);
  assert.ok(mine, "found for the owning team");
  assert.equal(mine!.id, "prj_1");
  const other = await summarizeForTeam("prj_1", TEAM_B, USER_1);
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
  const rows = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, "prj_1"));
  assert.notEqual(rows[0]!.valueEnc, "s3cret");
});

test("an app env var records its author and defaults to every runtime", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({ appId: "prj_1", key: "K", value: "v", type: "plain" });
    const [v] = await listEnv("prj_1");
    assert.deepEqual([...v!.targets].sort(), ["preview", "production"]);
    assert.equal(v!.createdBy?.id, USER_1);
    assert.equal(v!.updatedBy?.id, USER_1);
    assert.equal(v!.createdBy?.username, USER_1);
  });
});

test("an edit that names no targets PRESERVES the stored ones", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({
      appId: "prj_1",
      key: "STRIPE",
      value: "live",
      targets: ["production"],
      type: "plain",
    });
    await upsertEnv({
      appId: "prj_1",
      key: "STRIPE",
      value: "rotated",
      type: "plain",
    });
    const [v] = await listEnv("prj_1");
    assert.deepEqual(v!.targets, ["production"]);
    await upsertEnv({
      appId: "prj_1",
      key: "STRIPE",
      value: "rotated",
      targets: ["production", "preview"],
      type: "plain",
    });
    const [v2] = await listEnv("prj_1");
    assert.deepEqual([...v2!.targets].sort(), ["preview", "production"]);
  });
});

test("re-saving a secret is refused outright, targets and all", async () => {
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
    await assert.rejects(
      () =>
        upsertEnv({
          appId: "prj_1",
          key: "API_KEY",
          value: "••••••••••••",
          targets: ["production", "preview"],
          type: "secret",
        }),
      /cannot be edited/i,
    );
    const after = await db
      .select()
      .from(envVarsTable)
      .where(eq(envVarsTable.appId, "prj_1"));
    assert.equal(after[0]!.valueEnc, before[0]!.valueEnc, "value untouched");
    const list = await listEnv("prj_1");
    assert.deepEqual(list[0]!.targets, ["production"], "targets untouched");
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
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    });
    varId = (await listSharedVars())[0]!.id;
    await setSharedVarAppLink(varId, "prj_1", true);
  });
  assert.equal(
    (await db.select({ n: count() }).from(sharedEnvVarApps))[0]!.n,
    1,
  );
  await asUser1(() => setSharedVarAppLink(varId, "prj_1", false));
  assert.equal(
    (await db.select({ n: count() }).from(sharedEnvVarApps))[0]!.n,
    0,
  );
});

test("two concurrent same-name createApp calls both succeed with distinct slugs", async () => {
  const input = {
    name: "My App",
    source: "upload" as const,
    repo: null,
  };
  const [a, b] = await asUser1(() =>
    Promise.all([createApp(input), createApp(input)]),
  );
  assert.notEqual(
    a.slug,
    b.slug,
    "concurrent same-name creates get distinct slugs",
  );
  const rows = await db.select({ slug: appsTable.slug }).from(appsTable);
  assert.equal(rows.length, 2);
  assert.equal(
    new Set(rows.map((r) => r.slug)).size,
    2,
    "two unique slugs persisted",
  );
});

const IP = "1.2.3.4";

test("uniqueAutoDomainName never returns a host that already exists globally", async () => {
  await seedApp(db, { id: "prj_u", slug: "uniq" });
  const taken = new Set<string>();
  await asUser1(async () => {
    for (let i = 0; i < 25; i++) {
      const name = await uniqueAutoDomainName("uniq", IP);
      assert.ok(!taken.has(name), `generated a duplicate: ${name}`);
      taken.add(name);
      await ensureExtraDomain("prj_u", name, {
        port: 80,
        service: null,
        slug: "uniq",
        ip: IP,
      });
    }
  });
  const rows = await loadDomainsForApp("prj_u");
  assert.equal(new Set(rows.map((d) => d.name)).size, rows.length);
  assert.equal(rows.length, 25);
});

test("ensureExtraDomain regenerates (not skips) when the template host collides with ANOTHER project", async () => {
  await seedApp(db, { id: "prj_a", slug: "alpha" });
  await seedApp(db, { id: "prj_b", slug: "beta" });
  const shared = `shared-charming-otter-${"01020304"}.deplo.site`;
  await asUser1(() =>
    ensureExtraDomain("prj_a", shared, {
      port: 80,
      service: "web",
      slug: "alpha",
      ip: IP,
    }),
  );
  await asUser1(() =>
    ensureExtraDomain("prj_b", shared, {
      port: 80,
      service: "web",
      slug: "beta",
      ip: IP,
    }),
  );
  const bDomains = await loadDomainsForApp("prj_b");
  assert.equal(bDomains.length, 1, "B got a domain (regenerated, not dropped)");
  assert.notEqual(
    bDomains[0].name,
    shared,
    "B did not reuse A's colliding host",
  );
  assert.equal(
    wildcardEmbeddedIp(bDomains[0].name),
    IP,
    "B's host still encodes the IP",
  );
  const aDomains = await loadDomainsForApp("prj_a");
  assert.equal(aDomains[0].name, shared);
});

test("ensureExtraDomain is idempotent on the SAME project (re-run does not duplicate)", async () => {
  await seedApp(db, { id: "prj_c", slug: "gamma" });
  const host = `gamma-bold-lynx-${"01020304"}.deplo.site`;
  await asUser1(async () => {
    await ensureExtraDomain("prj_c", host, {
      port: 80,
      service: "web",
      slug: "gamma",
      ip: IP,
    });
    await ensureExtraDomain("prj_c", host, {
      port: 80,
      service: "web",
      slug: "gamma",
      ip: IP,
    });
  });
  const rows = await loadDomainsForApp("prj_c");
  assert.equal(
    rows.length,
    1,
    "the same host on the same project is not duplicated",
  );
  assert.equal(rows[0].name, host);
});

test("a template's displaced domain gets an address of its own, not silence", async () => {
  const serverIp = "10.0.0.1";
  const main = wildcardDomain("garage-s3", "bold-otter", serverIp);
  const app = await asUser1(() =>
    createApp({
      name: "Garage S3",
      source: "compose",
      repo: null,
      compose: "services:\n  garage: {}\n  garage-webui: {}\n",
      composeService: "garage-webui",
      composePort: 3909,
      autoDomain: main,
      extraDomains: [{ service: "garage", port: 3900, host: main }],
      deploy: false,
    }),
  );

  const rows = await loadDomainsForApp(app.id);
  assert.equal(
    rows.length,
    2,
    "both services the template publishes got a host",
  );
  const primary = rows.find((d) => d.primary)!;
  assert.equal(
    primary.name,
    main,
    "the marked primary keeps the generated main host",
  );
  assert.equal(primary.service, "garage-webui");
  assert.equal(primary.port, 3909);
  const extra = rows.find((d) => !d.primary)!;
  assert.notEqual(
    extra.name,
    main,
    "the displaced entry did not vanish onto the primary's host",
  );
  assert.equal(
    wildcardEmbeddedIp(extra.name),
    serverIp,
    "its regenerated host points at the same server",
  );
  assert.equal(extra.service, "garage");
  assert.equal(extra.port, 3900);
});

test("ensureAutoDomain regenerates when its `preferred` host belongs to another project", async () => {
  await seedApp(db, { id: "prj_x", slug: "xeno" });
  await seedApp(db, { id: "prj_y", slug: "yeti" });
  const preferred = `pref-keen-puma-${"01020304"}.deplo.site`;
  const xName = await asUser1(() =>
    ensureAutoDomain("prj_x", {
      slug: "xeno",
      ip: IP,
      preferred,
      defaultPort: 80,
    }),
  );
  assert.equal(xName, preferred);
  const yName = await asUser1(() =>
    ensureAutoDomain("prj_y", {
      slug: "yeti",
      ip: IP,
      preferred,
      defaultPort: 80,
    }),
  );
  assert.notEqual(yName, preferred, "Y regenerated rather than colliding");
  assert.equal(wildcardEmbeddedIp(yName), IP);
});

test("a path row on an already-verified hostname inherits its DNS status (and routes)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    const auto = await ensureAutoDomain("prj_1", {
      slug: "app",
      ip: "1.2.3.4",
      defaultPort: 80,
    });
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

    const routes = await routableRoutes("prj_1");
    assert.equal(
      routes.length,
      2,
      "both the whole-host and the /api row route",
    );
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
    const d = await addDomain("prj_1", "fresh.example.io", {
      pathPrefix: "/api",
    });
    assert.equal(d.status, "pending");
    assert.deepEqual(
      await routableRoutes("prj_1"),
      [],
      "unproven host is not routed",
    );
  });
});

test("addDomain without a certProvider is born WITHOUT a certificate (`none`)", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    const plain = await addDomain("prj_1", "plain.example.io", {});
    assert.equal(
      plain.certProvider,
      "none",
      "omitted provider ⇒ no certificate",
    );
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
    await ensureAutoDomain("prj_1", { slug: "plain", ip: IP, defaultPort: 80 });
    await ensureAutoDomain("prj_2", {
      slug: "tls",
      ip: IP,
      defaultPort: 80,
      certProvider: "letsencrypt",
    });
    await ensureExtraDomain("prj_2", "tls-extra-keen-owl-01020304.deplo.site", {
      port: 81,
      service: "web",
      slug: "tls",
      ip: IP,
      certProvider: "letsencrypt",
    });
  });
  const plain = await loadDomainsForApp("prj_1");
  assert.equal(plain.length, 1);
  assert.equal(
    plain[0].certProvider,
    "none",
    "stored explicitly, not left absent",
  );
  assert.equal(plain[0].ssl, false, "ssl mirrors the cert-less birth");
  const tls = await loadDomainsForApp("prj_2");
  assert.equal(tls.length, 2);
  for (const d of tls) {
    assert.equal(d.certProvider, "letsencrypt");
    assert.equal(d.ssl, true);
  }
});
