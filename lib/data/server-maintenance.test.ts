import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { teams as teamsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  canonicalTimezone,
  serverHostInfo,
  setServerTimezone,
  restartServerWorkloads,
  restartServerTraefik,
  restartDeploPanel,
} from "./server-maintenance";

/**
 * Data-layer tests for host maintenance. - restartServerWorkloads leaves stopped
 * workloads alone and reports per- workload failures instead of aborting at the
 * first one.
 */

let db: TestDb;
let pg: PGlite;

const REMOTE = "srv_remote";
/** RFC 5737 TEST-NET-1: never assigned to a real interface, so isDeploHostServer's
 *  comparison against this machine's NICs is decided by us, not by the runner. */
const REMOTE_IP = "192.0.2.10";
const SELF_IP = "192.0.2.200";
const SELF = "srv_self";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table databases, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
    ],
  });
  // Deliberately UNPROVISIONED (no pinned cert).
  await seedServerRow(db, {
    id: REMOTE,
    name: "remote-1",
    ip: REMOTE_IP,
    host: REMOTE_IP,
  });
  await seedServerRow(db, {
    id: SELF,
    name: "this-host",
    ip: SELF_IP,
    host: SELF_IP,
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

test("every entry point is instance-admin only", async () => {
  // A member of a team that can deploy here still has no say over the host: these
  // restart other teams' workloads and can take the box's routing down.
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["serverHostInfo", () => serverHostInfo(REMOTE)],
    ["setServerTimezone", () => setServerTimezone(REMOTE, "Europe/Rome")],
    ["restartServerWorkloads", () => restartServerWorkloads(REMOTE)],
    ["restartServerTraefik", () => restartServerTraefik(REMOTE)],
    ["restartDeploPanel", () => restartDeploPanel(SELF)],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(
      () => asMember(call),
      /instance admin/i,
      `${name} must be instance-admin gated`,
    );
  }
});

test("an unknown server is rejected, not dialed", async () => {
  await assert.rejects(
    () => asAdmin(() => serverHostInfo("srv_nope")),
    /not found/i,
  );
  await assert.rejects(
    () => asAdmin(() => restartServerWorkloads("srv_nope")),
    /not found/i,
  );
});

/* ------------------------------------------------------------------ */
/* Timezone                                                            */
/* ------------------------------------------------------------------ */

test("a bogus timezone is rejected before the host is dialed", async () => {
  // "+05:30" is the subtle one: Intl ACCEPTS a bare UTC offset, but it is not a
  // zone and no host has a file for it, so letting it through would turn a typo
  // into an error from the box instead of from the field that produced it.
  for (const bad of [
    "",
    "   ",
    "Mars/Olympus",
    "../../etc/passwd",
    "UTC+1",
    "+05:30",
    "-08:00",
  ]) {
    await assert.rejects(
      () => asAdmin(() => setServerTimezone(REMOTE, bad)),
      /not a timezone/i,
      `${bad || "(empty)"} must be refused`,
    );
  }
});

test("an alias reaches the host as its canonical name", async () => {
  // Both host write paths must end up recording the SAME string: timedatectl keeps
  // the name it is handed, the /etc/localtime relink keeps the file that name
  // resolves to.
  assert.equal(canonicalTimezone("europe/rome"), "Europe/Rome");
  assert.equal(canonicalTimezone("US/Eastern"), "America/New_York");
  assert.equal(canonicalTimezone("  Europe/Rome  "), "Europe/Rome");
  assert.equal(canonicalTimezone("UTC"), "UTC");
  // Not zones, whatever Intl thinks of them.
  assert.equal(canonicalTimezone("+05:30"), null);
  assert.equal(canonicalTimezone("Mars/Olympus"), null);
  assert.equal(canonicalTimezone(""), null);
});

test("a real IANA zone passes validation and goes on to the host", async () => {
  // Rejected by the unreachable agent, NOT by the validator, which is what says
  // the name was accepted. "Europe/Rome" is the case in the UI's own copy.
  for (const good of [
    "Europe/Rome",
    "America/Argentina/Salta",
    "UTC",
    "Asia/Kathmandu",
  ]) {
    await assert.rejects(
      () => asAdmin(() => setServerTimezone(REMOTE, good)),
      (e: Error) => {
        assert.doesNotMatch(
          e.message,
          /not a timezone/i,
          `${good} must be accepted`,
        );
        return true;
      },
    );
  }
});

/* ------------------------------------------------------------------ */
/* Restarts                                                            */
/* ------------------------------------------------------------------ */

test("only the host running Deplo can restart the Deplo panel", async () => {
  await assert.rejects(
    () => asAdmin(() => restartDeploPanel(REMOTE)),
    /does not run the Deplo panel/i,
  );
  // The Deplo host itself gets past the check and fails at the (unreachable) agent.
  await assert.rejects(
    () => asAdmin(() => restartDeploPanel(SELF)),
    (e: Error) => {
      assert.doesNotMatch(e.message, /does not run the Deplo panel/i);
      return true;
    },
  );
});

test("restarting workloads skips the stopped ones and never touches another server's", async () => {
  // seedApp names an App after its id, so the report below is keyed on those.
  await seedApp(db, {
    id: "prj_live",
    slug: "live",
    serverId: REMOTE,
    status: "active",
  });
  await seedApp(db, {
    id: "prj_off",
    slug: "off",
    serverId: REMOTE,
    status: "idle",
  });
  // On a DIFFERENT server: a whole-server restart must be exactly that.
  await seedApp(db, {
    id: "prj_other",
    slug: "other",
    serverId: SELF,
    status: "active",
  });
  await seedDatabase(db, {
    id: "db_live",
    name: "pg",
    serverId: REMOTE,
    status: "running",
  });

  const report = await asAdmin(() => restartServerWorkloads(REMOTE));

  // Two live workloads on this host, both attempted and both failing at the
  // unreachable agent; the stopped App is skipped rather than STARTED, which is a
  // different action than the one the operator pressed.
  assert.equal(report.skipped, 1);
  assert.equal(report.restarted, 0);
  assert.equal(
    report.failures.length,
    2,
    "each live workload is reported on its own",
  );
  const names = report.failures.map((f) => f.name).sort();
  assert.deepEqual(names, ["pg", "prj_live"]);
  assert.ok(
    !names.includes("prj_other"),
    "another server's workloads must not be touched",
  );
  // Both kinds are covered, not just Apps - a database is a stack on this host too.
  assert.deepEqual(report.failures.map((f) => f.kind).sort(), [
    "app",
    "database",
  ]);
  // A failure carries the host's own words rather than invented copy.
  assert.ok(report.failures.every((f) => f.error));
});

test("a server with nothing on it reports an empty restart rather than failing", async () => {
  const report = await asAdmin(() => restartServerWorkloads(REMOTE));
  assert.deepEqual(report, { restarted: 0, skipped: 0, failures: [] });
});

test("a failed deploy is restarted; a deploy in flight is left to finish", async () => {
  // `error` means the last DEPLOY failed, which routinely leaves the PREVIOUS
  // stack up and serving. Treating it as stopped skipped exactly the apps an
  // operator presses this button to fix, and called them "already stopped".
  await seedApp(db, {
    id: "prj_err",
    slug: "err",
    serverId: REMOTE,
    status: "error",
  });
  // Mid-deploy: stopping the stack out from under its own `compose up` is how a
  // whole-server restart leaves a half-built app behind. It comes up on its own.
  await seedApp(db, {
    id: "prj_build",
    slug: "build",
    serverId: REMOTE,
    status: "building",
  });
  await seedApp(db, {
    id: "prj_queued",
    slug: "queued",
    serverId: REMOTE,
    status: "queued",
  });
  await seedApp(db, {
    id: "prj_stopping",
    slug: "stopping",
    serverId: REMOTE,
    status: "stopping",
  });
  // Databases get the same treatment: `error` is restartable, mid-create is not.
  await seedDatabase(db, {
    id: "db_err",
    name: "pg-err",
    serverId: REMOTE,
    status: "error",
  });
  await seedDatabase(db, {
    id: "db_new",
    name: "pg-new",
    serverId: REMOTE,
    status: "provisioning",
  });
  await seedDatabase(db, {
    id: "db_off",
    name: "pg-off",
    serverId: REMOTE,
    status: "stopped",
  });

  const report = await asAdmin(() => restartServerWorkloads(REMOTE));

  assert.equal(
    report.skipped,
    5,
    "building, queued, stopping, provisioning, stopped",
  );
  assert.deepEqual(
    report.failures.map((f) => f.name).sort(),
    ["pg-err", "prj_err"],
    "the two red workloads are attempted, not written off as stopped",
  );
});

test("host details obey the team's two-factor policy, like every action here", async () => {
  // The policy gate lives in requireActiveTeamId, and every mutation on this page
  // already goes through it. A read that skipped it would hand a locked-out member
  // every host's hardware, disk and clock.
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));
  await assert.rejects(
    () => asAdmin(() => serverHostInfo(REMOTE)),
    /two-factor/i,
  );
});
