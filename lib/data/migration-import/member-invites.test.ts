import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { runWithIdentity } from "../../auth/request-context";
import { TEAM_B, USER_1 } from "../identity-test-helpers";
import {
  importMigrationMembers,
  listMigrationRunMembers,
} from "./member-invites";
import { beginMigration } from "./run-lifecycle";
import { migrationSessionRuns } from "./run-queries";
import { scanMigrationSource } from "./scan";
import {
  URL_BASE,
  CONNECT,
  source,
  asOwner,
  inBothTeams,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("an invited owner is told which panel they were owner on", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const invites = await asOwner(() =>
    importMigrationMembers({ ...CONNECT, runId }),
  );
  const owner = invites.find((i) => i.email === "owner@acme.test")!;
  assert.match(owner.message ?? "", /Was owner on Dokploy/);
  assert.doesNotMatch(owner.message ?? "", /\{panel\}/);
});

test("somebody on two teams of the panel gets ONE link for both", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  const second = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    beginMigration({ url: URL_BASE, sessionId: first }),
  );

  const a = await asOwner(() =>
    importMigrationMembers({ ...CONNECT, runId: first }),
  );
  const b = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    importMigrationMembers({ ...CONNECT, runId: second }),
  );

  const linkFor = (rows: typeof a, email: string): string | null =>
    rows.find((i) => i.email === email)?.link ?? null;
  assert.ok(linkFor(a, "owner@acme.test"));
  assert.equal(
    linkFor(a, "owner@acme.test"),
    linkFor(b, "owner@acme.test"),
    "the same person, the same link",
  );
  const links = await db.execute(
    "select count(*)::int as n from registration_links",
  );
  assert.equal(links.rows[0].n, 2, "one link per person, not per team");
  const joins = await db.execute(
    "select count(*)::int as n from registration_link_teams",
  );
  assert.equal(joins.rows[0].n, 4, "each link joins both teams");
});

test("the run records its people, and asking twice mints nothing new", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const first = await asOwner(() =>
    importMigrationMembers({ ...CONNECT, runId }),
  );
  const again = await asOwner(() =>
    importMigrationMembers({ ...CONNECT, runId }),
  );
  assert.deepEqual(
    again.map((i) => i.link),
    first.map((i) => i.link),
  );
  const links = await db.execute(
    "select count(*)::int as n from registration_links",
  );
  assert.equal(links.rows[0].n, 2);

  const recorded = await asOwner(() => listMigrationRunMembers(runId));
  assert.deepEqual(recorded.map((m) => m.email).sort(), [
    "dev@acme.test",
    "owner@acme.test",
  ]);
  assert.ok(recorded.every((m) => m.link));
});

test("the session lists every team of one walk, with its people", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  const second = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    beginMigration({ url: URL_BASE, sessionId: first }),
  );
  await asOwner(() => importMigrationMembers({ ...CONNECT, runId: first }));

  const runs = await asOwner(() => migrationSessionRuns(second));
  assert.deepEqual(
    runs.map((r) => r.id),
    [first, second],
  );
  assert.equal(runs[0].members.length, 2);
  assert.equal(runs[1].members.length, 0);
});

test("a member is listed by their own name, not by their address", async () => {
  source.fixtures["user.all"] = [
    {
      role: "admin",
      user: {
        email: "ada@acme.test",
        name: "ada@acme.test",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    },
    {
      role: "member",
      user: { email: "grace@acme.test", name: "grace@acme.test" },
    },
  ];
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.deepEqual(
    plan.members.map((m) => `${m.name}/${m.sourceRole}`),
    ["Ada Lovelace/admin", "grace/member"],
  );
});
