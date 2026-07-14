import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  dockerCleanupPolicy as policyTable,
  dockerCleanupPolicyScopes as policyScopesTable,
  dockerCleanupRuns as runsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, SERVER_1 } from "./app-graph-test-helpers";
import {
  seedCleanupPolicy,
  seedCleanupRun,
  TRUNCATE_CLEANUP,
} from "./docker-cleanup-test-helpers";
import {
  getCleanupPolicy,
  listCleanupRuns,
  previewCleanup,
  reconcileInFlightCleanupRuns,
  runCleanupNow,
  updateCleanupPolicy,
} from "./docker-cleanup";

/**
 * Data-layer tests for `docker-cleanup` against pglite. They cover the four things
 * that make this feature safe rather than merely working:
 *
 *  - the WRITE path's asymmetry — an unparseable cron is REJECTED (it would silently
 *    never fire) while the numeric bounds are merely CLAMPED,
 *  - the scopes junction being a whole-set replace (an unchecked scope must not survive
 *    a save, or the sweep deletes things the operator refused),
 *  - the defaults a never-configured instance reads, with `unused_app_images` OFF,
 *  - `manage_infra` gating every entry point, and the "history never lies" invariant:
 *    a sweep that could not even reach an agent still lands as a `failed` run.
 *
 * The seeded server has no agent (no cert fingerprint), so the executor fails at the
 * provisioning check without ever dialling — the same trick the backup tests use to
 * drive `executeBackup` end to end without a live agent.
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

/** A second, capability-poor principal: `view` only, so no `manage_infra`. */
const USER_VIEWER = "user_viewer";

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_CLEANUP}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_VIEWER, teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  await seedServer(db);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asViewer = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_VIEWER, teamId: TEAM_A }, fn);

/** A valid policy input; spread over it to make one field wrong. */
const VALID_INPUT = {
  enabled: true,
  schedule: "0 4 * * *",
  minAgeHours: 168,
  keepImagesPerApp: 1,
  scopes: ["build_cache", "dangling_images"] as const,
};

const scopeRows = () =>
  db.select().from(policyScopesTable).orderBy(policyScopesTable.scope);

const allRuns = () => db.select().from(runsTable);

/* ------------------------------------------------------------------ */
/* (a) The cron is rejected, not repaired                              */
/* ------------------------------------------------------------------ */

test("updateCleanupPolicy rejects an unparseable cron and writes nothing", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () => updateCleanupPolicy({ ...VALID_INPUT, scopes: [...VALID_INPUT.scopes], schedule: "every night" }),
      /not a valid cron expression/,
    );
  });
  // The rejection is the whole point: an accepted-but-unparseable cron never matches,
  // so the UI would report an enabled cleanup that silently never runs.
  assert.equal((await db.select().from(policyTable)).length, 0, "no policy row was written");
});

/* ------------------------------------------------------------------ */
/* (b) The numbers are clamped, not rejected                           */
/* ------------------------------------------------------------------ */

test("updateCleanupPolicy clamps minAgeHours and keepImagesPerApp into range", async () => {
  const tooLow = await asOwner(() =>
    updateCleanupPolicy({
      ...VALID_INPUT,
      scopes: [...VALID_INPUT.scopes],
      minAgeHours: -50,
      keepImagesPerApp: 0,
    }),
  );
  assert.equal(tooLow.minAgeHours, 0, "a negative age floors at 0 (no age filter)");
  assert.equal(tooLow.keepImagesPerApp, 1, "keep-per-app floors at 1 — never zero images kept");

  const tooHigh = await asOwner(() =>
    updateCleanupPolicy({
      ...VALID_INPUT,
      scopes: [...VALID_INPUT.scopes],
      minAgeHours: 100_000,
      keepImagesPerApp: 999,
    }),
  );
  assert.equal(tooHigh.minAgeHours, 8760, "a year is the ceiling");
  assert.equal(tooHigh.keepImagesPerApp, 20);

  // Clamped on the way to the ROW, not just in the returned DTO.
  const [row] = await db.select().from(policyTable);
  assert.equal(row!.minAgeHours, 8760);
  assert.equal(row!.keepImagesPerApp, 20);
});

/* ------------------------------------------------------------------ */
/* (c) The scopes junction is a whole-set replace                      */
/* ------------------------------------------------------------------ */

test("updateCleanupPolicy replaces the scopes junction whole-set", async () => {
  await seedCleanupPolicy(db, {
    scopes: ["build_cache", "dangling_images", "orphan_buildkit_cache"],
  });

  const saved = await asOwner(() =>
    updateCleanupPolicy({ ...VALID_INPUT, scopes: ["unused_app_images"] }),
  );

  // The three previously-selected scopes are GONE, not merged with the new one: a
  // scope that survived an unchecked box would reclaim things the operator refused.
  assert.deepEqual(saved.scopes, ["unused_app_images"]);
  assert.deepEqual(
    (await scopeRows()).map((r) => r.scope),
    ["unused_app_images"],
  );
});

test("updateCleanupPolicy refuses a scope outside the allow-list", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () =>
        updateCleanupPolicy({
          ...VALID_INPUT,
          // The forbidden verbs have no scope id, and inventing one must not create it.
          scopes: ["system_prune"] as never,
        }),
      /is not a Docker cleanup scope/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* (d) A missing policy row reads as the documented defaults           */
/* ------------------------------------------------------------------ */

test("getCleanupPolicy on a never-configured instance returns the defaults, unused_app_images OFF", async () => {
  const policy = await asOwner(() => getCleanupPolicy());

  assert.equal(policy.enabled, false, "cleanup is opt-in");
  assert.equal(policy.schedule, "0 4 * * *");
  assert.equal(policy.minAgeHours, 168);
  assert.equal(policy.keepImagesPerApp, 1);
  assert.equal(policy.updatedAt, null, "a missing row is legible as 'never saved'");
  assert.deepEqual(policy.excludedServerIds, []);
  // The three scopes that cannot strand an app. `unused_app_images` is absent BY
  // DESIGN: nothing pushes to a registry, so a removed app image is recoverable only
  // by a rebuild — a choice an operator makes, never a default they inherit.
  assert.deepEqual(policy.scopes, [
    "build_cache",
    "dangling_images",
    "orphan_buildkit_cache",
  ]);
  assert.ok(
    !policy.scopes.includes("unused_app_images"),
    "unused_app_images is never on by default",
  );
});

/* ------------------------------------------------------------------ */
/* (e) manage_infra gates every entry point                            */
/* ------------------------------------------------------------------ */

test("an identity without manage_infra is refused by every entry point", async () => {
  await seedCleanupPolicy(db, { enabled: true });

  await asViewer(async () => {
    const denied = /don't have permission to manage infrastructure/;
    await assert.rejects(() => getCleanupPolicy(), denied, "read of the policy");
    await assert.rejects(() => listCleanupRuns(), denied, "read of the history");
    await assert.rejects(
      () => updateCleanupPolicy({ ...VALID_INPUT, scopes: [...VALID_INPUT.scopes] }),
      denied,
      "write of the policy",
    );
    await assert.rejects(() => previewCleanup(SERVER_1), denied, "the dry-run probe");
    await assert.rejects(() => runCleanupNow(SERVER_1), denied, "the sweep itself");
  });

  // The gate holds BEFORE any side effect: no run row, and the policy is untouched.
  assert.equal((await allRuns()).length, 0);
});

/* ------------------------------------------------------------------ */
/* (f) History never lies                                              */
/* ------------------------------------------------------------------ */

test("runCleanupNow on a server with no live agent still records a failed run", async () => {
  await seedCleanupPolicy(db, { enabled: true });

  await asOwner(async () => {
    // It throws so the UI can toast the agent's message verbatim...
    await assert.rejects(() => runCleanupNow(SERVER_1), /not provisioned yet/);
  });

  // ...but only AFTER the attempt is on the record. This is the invariant: the
  // `running` row is written BEFORE the dial, so a sweep that could not even start
  // is a `failed` run, not a sweep that never happened.
  const runs = await allRuns();
  assert.equal(runs.length, 1, "the attempt landed in the history");
  const run = runs[0]!;
  assert.equal(run.status, "failed");
  assert.equal(run.serverId, SERVER_1);
  assert.equal(run.trigger, "manual");
  assert.equal(run.actor, USER_1);
  assert.equal(run.reclaimedBytes, 0);
  assert.ok(run.finishedAt, "a failed run is finished, not left hanging");
  assert.match(
    run.error ?? "",
    /not provisioned yet/,
    "the failure text is the one the operator can act on",
  );

  // And it is readable back through the gated history read.
  const listed = await asOwner(() => listCleanupRuns({ serverId: SERVER_1 }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, "failed");
});

/* ------------------------------------------------------------------ */
/* (g) The boot reconcile settles stranded runs                        */
/* ------------------------------------------------------------------ */

test("reconcileInFlightCleanupRuns fails a stranded run and leaves a fresh one alone", async () => {
  const stranded = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h ago
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString(); // 5min ago
  await seedCleanupRun(db, { id: "dcr_stranded", status: "running", startedAt: stranded });
  await seedCleanupRun(db, { id: "dcr_fresh", status: "running", startedAt: fresh });

  // Session-free by construction — a boot hook has no user to gate on.
  const flipped = await reconcileInFlightCleanupRuns();
  assert.equal(flipped, 1, "only the run past the 90min orphan window is settled");

  const [strandedRow] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, "dcr_stranded"));
  assert.equal(strandedRow!.status, "failed");
  assert.match(strandedRow!.error ?? "", /Interrupted by a control-plane restart/);
  assert.ok(strandedRow!.finishedAt);

  // A sweep that is genuinely still in flight must survive: flipping it would let the
  // scheduler stack a second `docker rmi` sweep on a host already running one.
  const [freshRow] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, "dcr_fresh"));
  assert.equal(freshRow!.status, "running");
  assert.equal(freshRow!.finishedAt, null);
});
