import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  services as servicesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "./identity-test-helpers";
import {
  seedServer,
  seedService,
  seedDeployment,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./service-graph-test-helpers";
import {
  cancelAllDeployments,
  cancelDeployment,
  listDeployments,
} from "./deployments";

/**
 * `cancelAllDeployments` against pglite — the "Stop all builds" bulk action.
 * Counterpart to the delete sweep: it flips only IN-PROGRESS (queued/building)
 * rows to `canceled`, leaves terminal deployments (ready/error/canceled) exactly
 * as they are, and is team-scoped so a foreign caller stops nothing.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const OWNER = "u_owner";
const OWNER_B = "u_owner_b";
const SVC = "prj_svc";
const SVC2 = "prj_svc2";
// A second host, so server-scoped sweeps have something to exclude. SVC lives on
// SERVER_1 (the seed default), SVC2 on SERVER_2.
const SERVER_2 = "srv_2";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: OWNER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db); // SERVER_1 (default)
  await seedServer(db, SERVER_2);
  await seedService(db, { id: SVC, teamId: TEAM_A, serverId: SERVER_1 });
  await seedService(db, { id: SVC2, teamId: TEAM_A, slug: "svc2", serverId: SERVER_2 });
  await seedDeployment(db, { id: "dep_ready", serviceId: SVC, status: "ready" });
  await seedDeployment(db, { id: "dep_error", serviceId: SVC, status: "error" });
  await seedDeployment(db, { id: "dep_canceled", serviceId: SVC, status: "canceled" });
  await seedDeployment(db, { id: "dep_queued", serviceId: SVC, status: "queued" });
  await seedDeployment(db, { id: "dep_building", serviceId: SVC, status: "building" });
});

/** Ids currently in `canceled`, sorted — the terminal state cancel flips rows to. */
const canceledIds = async (): Promise<string[]> =>
  (
    await db
      .select({ id: deploymentsTable.id, status: deploymentsTable.status })
      .from(deploymentsTable)
  )
    .filter((r) => r.status === "canceled")
    .map((r) => r.id)
    .sort();

test("cancelAllDeployments(serviceId) stops queued/building, leaves finished", async () => {
  const n = await as(OWNER, TEAM_A, () => cancelAllDeployments(SVC));
  assert.equal(n, 2, "the queued + building deployments are stopped");
  assert.deepEqual(
    await canceledIds(),
    ["dep_building", "dep_canceled", "dep_queued"],
    "the two in-progress rows join the pre-existing canceled one; ready/error untouched",
  );
});

test("cancelAllDeployments() sweeps the whole team's in-progress builds", async () => {
  // A second service with its own in-progress build — the team-wide sweep must
  // reach it too, not just the first service.
  await seedDeployment(db, { id: "dep_q2", serviceId: SVC2, status: "queued" });
  const n = await as(OWNER, TEAM_A, () => cancelAllDeployments());
  assert.equal(n, 3, "both services' queued/building deployments are stopped");
  assert.deepEqual(await canceledIds(), [
    "dep_building",
    "dep_canceled",
    "dep_q2",
    "dep_queued",
  ]);
});

test("cancelAllDeployments returns 0 when nothing is in progress", async () => {
  await as(OWNER, TEAM_A, () => cancelAllDeployments(SVC)); // drains queued+building
  const n = await as(OWNER, TEAM_A, () => cancelAllDeployments(SVC));
  assert.equal(n, 0, "a second sweep finds no queued/building rows to stop");
});

test("a caller can't cancel another team's builds (team isolation)", async () => {
  const n = await as(OWNER_B, TEAM_B, () => cancelAllDeployments());
  assert.equal(n, 0, "team B has no in-progress builds of its own");
  assert.deepEqual(
    await canceledIds(),
    ["dep_canceled"],
    "team A's queued/building deployments are untouched",
  );
});

test("cancelAllDeployments(foreignServiceId) throws — not this team's service", async () => {
  await assert.rejects(
    as(OWNER_B, TEAM_B, () => cancelAllDeployments(SVC)),
    /not found/i,
    "a cross-team serviceId is rejected before any write",
  );
  assert.deepEqual(
    await canceledIds(),
    ["dep_canceled"],
    "no in-progress row was flipped",
  );
});

const statusOf = async (id: string): Promise<string> =>
  (
    await db
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, id))
  )[0]!.status;

test("cancelAllDeployments(null, serverId) stops only that server's builds", async () => {
  // SVC2 (on SERVER_2) has its own queued build; the SERVER_1 sweep must leave it.
  await seedDeployment(db, { id: "dep_q2", serviceId: SVC2, status: "queued" });
  const n = await as(OWNER, TEAM_A, () => cancelAllDeployments(null, SERVER_1));
  assert.equal(n, 2, "only SVC's queued+building on SERVER_1 are stopped");
  assert.deepEqual(await canceledIds(), [
    "dep_building",
    "dep_canceled",
    "dep_queued",
  ]);
  assert.equal(
    await statusOf("dep_q2"),
    "queued",
    "SVC2's build on SERVER_2 is untouched by a SERVER_1 sweep",
  );
});

test("server filter matches the deployment's own server_id over the service's", async () => {
  // SVC lives on SERVER_1, but THIS build ran on SERVER_2 (row server_id set) —
  // the effective-server coalesce must route it to the SERVER_2 sweep.
  await seedDeployment(db, {
    id: "dep_moved",
    serviceId: SVC,
    status: "queued",
    serverId: SERVER_2,
  });
  const n = await as(OWNER, TEAM_A, () => cancelAllDeployments(null, SERVER_2));
  assert.equal(n, 1, "only the build that actually ran on SERVER_2 is stopped");
  assert.equal(await statusOf("dep_moved"), "canceled");
  assert.equal(
    await statusOf("dep_queued"),
    "queued",
    "SVC's other queued build (null server_id → SERVER_1) is left",
  );
});

const serviceStatusOf = async (id: string): Promise<string> =>
  (
    await db
      .select({ status: servicesTable.status })
      .from(servicesTable)
      .where(eq(servicesTable.id, id))
  )[0]!.status;

test("canceling a service's build settles the service off 'building'", async () => {
  // Put SVC into the "building" state its in-flight deploy leaves it in.
  await db
    .update(servicesTable)
    .set({ status: "building" })
    .where(eq(servicesTable.id, SVC));
  await as(OWNER, TEAM_A, () => cancelAllDeployments(SVC));
  assert.equal(
    await serviceStatusOf(SVC),
    "idle",
    "the service drops to idle (Stopped) at once, not stuck building",
  );
});

test("canceling one queued build leaves the service building while another is in progress", async () => {
  // SVC is building (dep_building) with dep_queued also in progress. Canceling
  // ONLY the queued one must not settle the service — a build is still running.
  await db
    .update(servicesTable)
    .set({ status: "building" })
    .where(eq(servicesTable.id, SVC));
  await as(OWNER, TEAM_A, () => cancelDeployment("dep_queued"));
  assert.equal(await statusOf("dep_queued"), "canceled");
  assert.equal(
    await serviceStatusOf(SVC),
    "building",
    "dep_building is still in progress, so the service stays building",
  );
});

test("canceling does not clobber a service that isn't building/queued", async () => {
  // SVC2 is running ("active") with a single stray queued build. Canceling it
  // leaves zero in-progress builds, but the status guard must still spare an
  // active service — only building/queued ones settle to idle.
  await seedDeployment(db, {
    id: "dep_active_svc2",
    serviceId: SVC2,
    status: "queued",
  });
  await db
    .update(servicesTable)
    .set({ status: "active" })
    .where(eq(servicesTable.id, SVC2));
  await as(OWNER, TEAM_A, () => cancelDeployment("dep_active_svc2"));
  assert.equal(await statusOf("dep_active_svc2"), "canceled");
  assert.equal(
    await serviceStatusOf(SVC2),
    "active",
    "an active service is left alone even with no builds remaining",
  );
});

test("listDeployments decorates each row with its owning server", async () => {
  // A build whose row server_id points at SERVER_2 even though SVC is on SERVER_1.
  await seedDeployment(db, {
    id: "dep_moved",
    serviceId: SVC,
    status: "ready",
    serverId: SERVER_2,
  });
  const list = await as(OWNER, TEAM_A, () => listDeployments());
  const byId = new Map(list.map((d) => [d.id, d]));
  assert.equal(
    byId.get("dep_ready")?.serverName,
    SERVER_1,
    "a null row server_id falls back to the service's current server",
  );
  assert.equal(
    byId.get("dep_moved")?.serverName,
    SERVER_2,
    "the row's own server_id wins when present",
  );
});
