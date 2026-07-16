import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { domains as domainsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addDomain,
  updateDomain,
  verifyDomain,
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains";

/**
 * Domain DNS auto-check semantics: adding (and renaming) a domain checks its
 * DNS at write time so a pre-pointed host is born routable with zero manual
 * steps, an unresolvable host reads `pending` (not the accusatory
 * `misconfigured`, reserved for DNS that resolves to the WRONG address), and
 * `verifyDomain` reports `statusChanged` so the resolver can skip the routing
 * re-apply on the no-change checks the domains page runs on its interval.
 *
 * The resolver is stubbed per-test ({@link __setDnsResolve4ForTest}); the
 * seeded server's IP is 10.0.0.1, so that is the "points here" target.
 */

const SERVER_IP = "10.0.0.1"; // seedServer's ip — the classify target
const CLOUDFLARE_IP = "104.16.1.1"; // inside Cloudflare's 104.16.0.0/13
const ELSEWHERE_IP = "203.0.113.9"; // TEST-NET-3 — an unrelated address

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", status: "active" });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* addDomain checks DNS at write time                                   */
/* ------------------------------------------------------------------ */

test("addDomain: a host already pointing at the server is born valid + ssl", async () => {
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
  const d = await asUser1(() => addDomain("prj_1", "live.example.io", {}));
  assert.equal(d.status, "valid");
  assert.equal(d.ssl, true);
});

test("addDomain: a Cloudflare-proxied host is born cloudflare + ssl", async () => {
  __setDnsResolve4ForTest(async () => [CLOUDFLARE_IP]);
  const d = await asUser1(() => addDomain("prj_1", "cf.example.io", {}));
  assert.equal(d.status, "cloudflare");
  assert.equal(d.ssl, true);
});

test("addDomain: a host that doesn't resolve yet is pending, not misconfigured", async () => {
  __setDnsResolve4ForTest(async () => {
    throw new Error("NXDOMAIN");
  });
  const d = await asUser1(() => addDomain("prj_1", "new.example.io", {}));
  assert.equal(d.status, "pending");
  assert.equal(d.ssl, false);
});

test("addDomain: a host resolving elsewhere is born misconfigured", async () => {
  __setDnsResolve4ForTest(async () => [ELSEWHERE_IP]);
  const d = await asUser1(() => addDomain("prj_1", "wrong.example.io", {}));
  assert.equal(d.status, "misconfigured");
  assert.equal(d.ssl, false);
});

/* ------------------------------------------------------------------ */
/* verifyDomain: statuses + the statusChanged flag                      */
/* ------------------------------------------------------------------ */

test("verifyDomain: pending → valid reports statusChanged; re-verify doesn't", async () => {
  __setDnsResolve4ForTest(async () => []);
  const d = await asUser1(() => addDomain("prj_1", "flip.example.io", {}));
  assert.equal(d.status, "pending");

  // DNS record lands — the next check (the page's automatic one) flips it.
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
  const flipped = await asUser1(() => verifyDomain(d.id));
  assert.equal(flipped.status, "valid");
  assert.equal(flipped.ssl, true);
  assert.equal(flipped.statusChanged, true, "the flip must report a change");

  // Same answer again ⇒ no change ⇒ the caller can skip re-applying routing.
  const again = await asUser1(() => verifyDomain(d.id));
  assert.equal(again.status, "valid");
  assert.equal(again.statusChanged, false, "a settled re-check is a no-op");
});

test("verifyDomain: an unresolvable host stays pending and never gains ssl", async () => {
  __setDnsResolve4ForTest(async () => []);
  const d = await asUser1(() => addDomain("prj_1", "wait.example.io", {}));
  const checked = await asUser1(() => verifyDomain(d.id));
  assert.equal(checked.status, "pending");
  assert.equal(checked.ssl, false, "pending must not turn ssl on");
  assert.equal(checked.statusChanged, false);
});

test("verifyDomain: wrong-address DNS settles misconfigured", async () => {
  __setDnsResolve4ForTest(async () => []);
  const d = await asUser1(() => addDomain("prj_1", "bad.example.io", {}));
  __setDnsResolve4ForTest(async () => [ELSEWHERE_IP]);
  const checked = await asUser1(() => verifyDomain(d.id));
  assert.equal(checked.status, "misconfigured");
  assert.equal(checked.ssl, false);
  assert.equal(checked.statusChanged, true);
});

/* ------------------------------------------------------------------ */
/* updateDomain: a rename re-checks the NEW host                        */
/* ------------------------------------------------------------------ */

test("rename to a pre-pointed host keeps the domain routable (checked at write)", async () => {
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
  const d = await asUser1(() => addDomain("prj_1", "old.example.io", {}));
  assert.equal(d.status, "valid");

  await asUser1(() => updateDomain(d.id, { name: "next.example.io" }));
  const rows = await db.select().from(domainsTable);
  const renamed = rows.find((r) => r.id === d.id)!;
  assert.equal(renamed.name, "next.example.io");
  assert.equal(renamed.status, "valid", "pre-pointed rename never drops routing");
  assert.equal(renamed.ssl, true);
});

test("rename to an unresolvable host drops to pending and stops ssl", async () => {
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
  const d = await asUser1(() => addDomain("prj_1", "was.example.io", {}));
  __setDnsResolve4ForTest(async () => []);
  await asUser1(() => updateDomain(d.id, { name: "unset.example.io" }));
  const rows = await db.select().from(domainsTable);
  const renamed = rows.find((r) => r.id === d.id)!;
  assert.equal(renamed.status, "pending");
  assert.equal(renamed.ssl, false);
});
