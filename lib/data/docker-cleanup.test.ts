import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  dockerCleanupPolicy as policyTable,
  dockerCleanupPolicyScopes as policyScopesTable,
  dockerCleanupRunItems as runItemsTable,
  dockerCleanupRuns as runsTable,
} from "../db/schema/control-plane/docker-cleanup";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedPreview,
  seedServer,
  SERVER_1,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  seedCleanupPolicy,
  seedCleanupRun,
  TRUNCATE_CLEANUP,
} from "./docker-cleanup-test-helpers";
import { CleanupScope } from "../agent/gen/agent";
import {
  serversWithDeploySweepInFlight,
  sweepSupersededAppImages,
} from "./docker-cleanup/deploy-sweep";
import {
  liveNetworkNames,
  liveStackSlugs,
} from "./docker-cleanup/live-inventory";
import {
  getCleanupPolicy,
  setServerCleanupExcluded,
  updateCleanupPolicy,
} from "./docker-cleanup/policy";
import {
  listCleanupRuns,
  pruneCleanupRunHistory,
  reconcileInFlightCleanupRuns,
} from "./docker-cleanup/run-history";
import { CLEANUP_SCOPES, deploySweepScopes } from "./docker-cleanup/scopes";
import { __settleCleanupSweeps, runCleanupNow } from "./docker-cleanup/sweep";

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

const USER_VIEWER = "user_viewer";
const USER_INFRA = "user_infra";

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_CLEANUP}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: USER_VIEWER,
        teamId: TEAM_A,
        role: "viewer",
        capabilities: ["view"],
      },
      {
        id: USER_INFRA,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups"],
        isInstanceAdmin: false,
      },
    ],
  });
  await seedServer(db);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asViewer = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_VIEWER, teamId: TEAM_A }, fn);

const asInfraMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_INFRA, teamId: TEAM_A }, fn);

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

test("updateCleanupPolicy rejects an unparseable cron and writes nothing", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () =>
        updateCleanupPolicy({
          ...VALID_INPUT,
          scopes: [...VALID_INPUT.scopes],
          schedule: "every night",
        }),
      /not a valid cron expression/,
    );
  });
  // An accepted-but-unparseable cron never matches, so the UI would report an enabled
  // cleanup that silently never runs.
  assert.equal(
    (await db.select().from(policyTable)).length,
    0,
    "no policy row was written",
  );
});

test("updateCleanupPolicy clamps minAgeHours and keepImagesPerApp into range", async () => {
  const tooLow = await asOwner(() =>
    updateCleanupPolicy({
      ...VALID_INPUT,
      scopes: [...VALID_INPUT.scopes],
      minAgeHours: -50,
      keepImagesPerApp: 0,
    }),
  );
  assert.equal(
    tooLow.minAgeHours,
    0,
    "a negative age floors at 0 (no age filter)",
  );
  assert.equal(
    tooLow.keepImagesPerApp,
    1,
    "keep-per-app floors at 1, never zero images kept",
  );

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

  const [row] = await db.select().from(policyTable);
  assert.equal(row!.minAgeHours, 8760);
  assert.equal(row!.keepImagesPerApp, 20);
});

test("updateCleanupPolicy replaces the scopes junction whole-set", async () => {
  await seedCleanupPolicy(db, {
    scopes: ["build_cache", "dangling_images", "orphan_volumes"],
  });

  const saved = await asOwner(() =>
    updateCleanupPolicy({ ...VALID_INPUT, scopes: ["unused_app_images"] }),
  );

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
          scopes: ["system_prune"] as never,
        }),
      /is not a Docker cleanup scope/,
    );
  });
});

test("getCleanupPolicy on a never-configured instance is ENABLED with every scope", async () => {
  const policy = await asOwner(() => getCleanupPolicy());

  assert.equal(policy.enabled, true, "cleanup is ON by default");
  assert.equal(policy.schedule, "0 4 * * *");
  assert.equal(policy.minAgeHours, 24);
  assert.equal(policy.keepImagesPerApp, 1);
  assert.equal(
    policy.updatedAt,
    null,
    "a missing row is legible as 'never saved'",
  );
  assert.deepEqual(policy.excludedServerIds, []);
  assert.deepEqual(policy.scopes, [
    "build_cache",
    "dangling_images",
    "orphan_volumes",
    "unused_app_images",
    "unused_pulled_images",
    "leftover_app_files",
    "leftover_networks",
  ]);
});

// Reading a scope's absence from a saved policy as "turned off" made every new scope dead on
// arrival: this policy was saved 2026-07-19 and never once ran `leftover_app_files` (shipped
// 08-23), nor would it have run `leftover_networks`.
test("a scope added after the policy was saved is ON, not silently off", async () => {
  await seedCleanupPolicy(db, {
    scopes: [
      "build_cache",
      "dangling_images",
      "orphan_buildkit_cache",
      "unused_app_images",
    ],
    updatedAt: "2026-07-19T23:28:23.124Z",
  });
  const policy = await asOwner(() => getCleanupPolicy());
  assert.ok(
    policy.scopes.includes("leftover_app_files"),
    "a scope that shipped after the save was never a box the operator unticked",
  );
  assert.ok(policy.scopes.includes("leftover_networks"));
  assert.ok(policy.scopes.includes("orphan_volumes"));
  assert.ok(policy.scopes.includes("unused_pulled_images"));
  assert.ok(
    !policy.scopes.some((s) => (s as string) === "orphan_buildkit_cache"),
  );
});

test("a scope the operator unticked stays off", async () => {
  await seedCleanupPolicy(db, {
    scopes: ["dangling_images", "orphan_volumes", "unused_app_images"],
    updatedAt: "2026-12-01T00:00:00.000Z",
  });
  const policy = await asOwner(() => getCleanupPolicy());
  assert.ok(
    !policy.scopes.includes("build_cache"),
    "the unticked one is honoured",
  );
  assert.ok(!policy.scopes.includes("leftover_networks"));
});

test("a saved policy always wins over the defaults - an explicit disable survives", async () => {
  await seedCleanupPolicy(db, { enabled: false });
  const policy = await asOwner(() => getCleanupPolicy());
  assert.equal(
    policy.enabled,
    false,
    "the operator's disable is never overridden",
  );
});

const denied = /Only an instance admin can do that/;

async function assertEveryEntryPointRefused() {
  await assert.rejects(() => getCleanupPolicy(), denied, "read of the policy");
  await assert.rejects(() => listCleanupRuns(), denied, "read of the history");
  await assert.rejects(
    () =>
      updateCleanupPolicy({ ...VALID_INPUT, scopes: [...VALID_INPUT.scopes] }),
    denied,
    "write of the policy",
  );
  await assert.rejects(
    () => runCleanupNow(SERVER_1),
    denied,
    "the sweep itself",
  );
  await assert.rejects(
    () => setServerCleanupExcluded(SERVER_1, true),
    denied,
    "leaving a host out of the schedule",
  );
}

test("a server's own page toggles only ITS membership, never the whole list", async () => {
  await seedCleanupPolicy(db, { enabled: true });
  await seedServer(db, "srv_second");

  await asOwner(async () => {
    await updateCleanupPolicy({
      ...VALID_INPUT,
      scopes: [...VALID_INPUT.scopes],
      excludedServerIds: [SERVER_1, "srv_second"],
    });

    const after = await setServerCleanupExcluded(SERVER_1, false);
    assert.deepEqual(after.excludedServerIds, ["srv_second"]);

    await setServerCleanupExcluded(SERVER_1, true);
    const twice = await setServerCleanupExcluded(SERVER_1, true);
    assert.deepEqual(
      twice.excludedServerIds.sort(),
      [SERVER_1, "srv_second"].sort(),
    );
  });
});

test("a per-host toggle for a server that does not exist is refused", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () => setServerCleanupExcluded("srv_nope", true),
      /Server not found/,
    );
  });
});

test("a plain member is refused by every entry point", async () => {
  await seedCleanupPolicy(db, { enabled: true });
  await asViewer(assertEveryEntryPointRefused);
  assert.equal((await allRuns()).length, 0);
});

test("manage_infra alone does NOT reach Docker cleanup - the gate is instance-admin", async () => {
  await seedCleanupPolicy(db, { enabled: true });

  await asInfraMember(assertEveryEntryPointRefused);

  assert.equal((await allRuns()).length, 0);
});

test("runCleanupNow answers `running` at once and records the failure in the background", async () => {
  await seedCleanupPolicy(db, { enabled: true });

  const started = await asOwner(() => runCleanupNow(SERVER_1));
  assert.equal(started.status, "running");
  assert.equal(started.finishedAt, null);
  assert.equal(started.trigger, "manual");
  assert.equal(started.actor, USER_1);
  assert.deepEqual(started.items, []);

  await __settleCleanupSweeps();

  const runs = await allRuns();
  assert.equal(runs.length, 1, "the attempt landed in the history");
  const run = runs[0]!;
  assert.equal(run.id, started.id, "the same run the click was answered with");
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

  const listed = await asOwner(() => listCleanupRuns({ serverId: SERVER_1 }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, "failed");
});

test("a second sweep is refused while one is already running on that host", async () => {
  await seedCleanupPolicy(db, { enabled: true });
  await seedCleanupRun(db, {
    id: "dcr_live",
    status: "running",
    startedAt: new Date().toISOString(),
  });

  await asOwner(async () => {
    await assert.rejects(() => runCleanupNow(SERVER_1), /already running/);
  });
  assert.equal((await allRuns()).length, 1, "no second run row was written");
});

test("reconcileInFlightCleanupRuns fails a stranded run and leaves a fresh one alone", async () => {
  const stranded = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
  await seedCleanupRun(db, {
    id: "dcr_stranded",
    status: "running",
    startedAt: stranded,
  });
  await seedCleanupRun(db, {
    id: "dcr_fresh",
    status: "running",
    startedAt: fresh,
  });

  const flipped = await reconcileInFlightCleanupRuns();
  assert.equal(
    flipped,
    1,
    "only the run past the 90min orphan window is settled",
  );

  const [strandedRow] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, "dcr_stranded"));
  assert.equal(strandedRow!.status, "failed");
  assert.match(
    strandedRow!.error ?? "",
    /Interrupted by a control-plane restart/,
  );
  assert.ok(strandedRow!.finishedAt);

  const [freshRow] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, "dcr_fresh"));
  assert.equal(freshRow!.status, "running");
  assert.equal(freshRow!.finishedAt, null);
});

test("pruneCleanupRunHistory keeps the newest 3×servers and never a running row", async () => {
  await seedCleanupRun(db, {
    id: "dcr_stuck",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  for (let i = 1; i <= 5; i++) {
    await seedCleanupRun(db, {
      id: `dcr_t${i}`,
      startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      items: [
        {
          scope: "build_cache",
          reclaimedBytes: 1,
          itemsRemoved: 1,
          skipped: false,
          error: null,
        },
      ],
    });
  }

  const removed = await pruneCleanupRunHistory();
  assert.equal(
    removed,
    2,
    "t1 and t2 fall past the cap; the running row is immortal",
  );

  const left = (await allRuns()).map((r) => r.id).sort();
  assert.deepEqual(left, ["dcr_stuck", "dcr_t3", "dcr_t4", "dcr_t5"]);

  const itemRuns = (await db.select().from(runItemsTable))
    .map((i) => i.runId)
    .sort();
  assert.deepEqual(itemRuns, ["dcr_t3", "dcr_t4", "dcr_t5"]);
});

test("the executor prunes after every sweep - even a failed one", async () => {
  await seedCleanupPolicy(db, { enabled: true });
  for (let i = 1; i <= 6; i++) {
    await seedCleanupRun(db, {
      id: `dcr_h${i}`,
      startedAt: `2026-01-0${i}T00:00:00.000Z`,
    });
  }

  await asOwner(() => runCleanupNow(SERVER_1));
  await __settleCleanupSweeps();

  const runs = await allRuns();
  assert.equal(runs.length, 3);
  const ids = runs.map((r) => r.id);
  assert.ok(
    ids.includes("dcr_h5") && ids.includes("dcr_h6"),
    "the newest survivors",
  );
  assert.ok(
    runs.some((r) => r.status === "failed" && r.actor === USER_1),
    "the fresh failed run is the newest kept row",
  );
});

test("the deploy-time sweep runs the image and cache scopes the policy has, nothing else", () => {
  assert.deepEqual(
    deploySweepScopes(["dangling_images", "leftover_app_files"]),
    [],
  );
  assert.deepEqual(deploySweepScopes(["unused_app_images"]), [
    CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
  ]);
  assert.deepEqual(
    deploySweepScopes([...CLEANUP_SCOPES]),
    [
      CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
      CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
    ],
    "the cache ceiling rides the deploy too; the leftover scopes never do",
  );
});

test("sweepSupersededAppImages honors the policy's controls and never throws", async () => {
  await seedCleanupPolicy(db, { scopes: ["dangling_images"] });
  assert.equal(await sweepSupersededAppImages(SERVER_1), 0);

  await pg.exec(TRUNCATE_CLEANUP);
  await seedCleanupPolicy(db, {
    scopes: ["unused_app_images"],
    excludedServerIds: [SERVER_1],
  });
  assert.equal(await sweepSupersededAppImages(SERVER_1), 0);

  await pg.exec(TRUNCATE_CLEANUP);
  await seedCleanupPolicy(db, { scopes: ["unused_app_images"] });
  assert.equal(await sweepSupersededAppImages(SERVER_1), 0);
  assert.equal(
    (await allRuns()).length,
    0,
    "the deploy-time sweep writes no history",
  );
  assert.deepEqual(
    serversWithDeploySweepInFlight(),
    [],
    "no sweep left in flight",
  );
});

test("the live inventory names apps, their previews and databases", async () => {
  await seedApp(db, { id: "prj_live", slug: "web" });
  await seedPreview(db, { id: "prv_live", appId: "prj_live", prNumber: 7 });
  await seedDatabase(db, { id: "db_live", name: "shop" });

  const slugs = await asOwner(() => liveStackSlugs());
  assert.ok(slugs.includes("web"), `apps: ${slugs}`);
  assert.ok(slugs.includes("web__pr-7"), `previews: ${slugs}`);
  assert.ok(slugs.includes("db-shop"), `databases: ${slugs}`);
});

test("a torn-down preview vouches for neither a files dir nor a network", async () => {
  await seedApp(db, { id: "prj_live", slug: "web" });
  await seedPreview(db, { id: "prv_up", appId: "prj_live", prNumber: 7 });
  await seedPreview(db, {
    id: "prv_gone",
    appId: "prj_live",
    prNumber: 8,
    state: "closed",
    tornDownAt: "2026-01-01T00:00:00.000Z",
  });
  await seedPreview(db, {
    id: "prv_evicted",
    appId: "prj_live",
    prNumber: 9,
    status: "evicted",
    tornDownAt: null,
  });

  const slugs = await asOwner(() => liveStackSlugs());
  assert.ok(slugs.includes("web__pr-7"));
  assert.ok(slugs.includes("web__pr-9"), "unconfirmed teardown stays live");
  assert.ok(!slugs.includes("web__pr-8"), "confirmed gone is not live");

  const nets = await asOwner(() => liveNetworkNames());
  assert.ok(nets.includes("deplo-preview-web__pr-7"));
  assert.ok(nets.includes("deplo-preview-web__pr-9"));
  assert.ok(!nets.includes("deplo-preview-web__pr-8"), `networks: ${nets}`);
});
