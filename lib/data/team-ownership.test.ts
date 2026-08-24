import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { capabilitiesForRole } from "../membership-shared";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { removeMember } from "./members";
import { transferTeamOwnership } from "./team-ownership";

/**
 * Handing a team over — the one write that ever moves `teams.founder_user_id`.
 *
 * The crown is immutable to every other hand (an owner can't remove or demote
 * the founder), so this path is the ONLY exit from "the person who created the
 * team left the company". Which makes both halves worth pinning: that it works
 * for the founder with the right password, and that nobody else can fire it —
 * an assigned owner reaching it would sidestep every founder guard at once.
 */

let db: TestDb;
let pg: PGlite;

const FOUNDER = "founder1";
const OWNER = "owner2";
const MEMBER = "member3";
const SEEDED_PW = "password1";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** The founder, a second (assigned) owner, and a plain member. */
async function seedTeam(opts: { suspendOwner?: boolean } = {}) {
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha", founderUserId: FOUNDER }],
    users: [
      { id: FOUNDER, teamId: TEAM_A, role: "owner" },
      {
        id: OWNER,
        teamId: TEAM_A,
        role: "owner",
        suspended: opts.suspendOwner,
      },
      { id: MEMBER, teamId: TEAM_A, role: "member" },
    ],
  });
}

const founderOf = async (teamId: string) =>
  (
    await db
      .select({ founderUserId: teamsTable.founderUserId })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0]?.founderUserId ?? null;

test("the founder hands the team to another owner", async () => {
  await seedTeam();
  await asUser(FOUNDER, () =>
    transferTeamOwnership({ userId: OWNER, password: SEEDED_PW }),
  );
  assert.equal(await founderOf(TEAM_A), OWNER);
});

test("an assigned owner cannot hand the team to themselves", async () => {
  await seedTeam();
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => transferTeamOwnership({ userId: MEMBER, password: SEEDED_PW }),
      /Only the team's primary owner/,
    );
  });
  assert.equal(await founderOf(TEAM_A), FOUNDER);
});

test("a wrong password refuses the transfer", async () => {
  await seedTeam();
  await asUser(FOUNDER, async () => {
    await assert.rejects(
      () => transferTeamOwnership({ userId: OWNER, password: "not-it" }),
      /password is not correct/,
    );
  });
  assert.equal(await founderOf(TEAM_A), FOUNDER);
});

/**
 * The crown IS full access, so a plain member can receive it — the transfer puts
 * them on the Owner role itself. Requiring the rank up front blocked nothing (the
 * same admin grants it with one click) and allowed the incoherent end state this
 * asserts against: a crowned member who reaches only part of their own team, and
 * whose permissions no one is allowed to widen ever again.
 */
test("a plain member is put on the Owner role by the transfer", async () => {
  await seedTeam();
  await asUser(FOUNDER, () =>
    transferTeamOwnership({ userId: MEMBER, password: SEEDED_PW }),
  );
  assert.equal(await founderOf(TEAM_A), MEMBER);

  const m = (
    await db
      .select({
        rank: membershipsTable.role,
        roleId: membershipsTable.roleId,
        granular: membershipsTable.granular,
        custom: membershipsTable.customCapabilities,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, MEMBER),
          eq(membershipsTable.teamId, TEAM_A),
        ),
      )
      .limit(1)
  )[0]!;
  assert.equal(m.rank, "owner");
  assert.equal(m.granular, false);
  assert.equal(m.custom, false);
  assert.notEqual(m.roleId, null);

  // The effective set every authorization check reads is the Owner one.
  const caps = await db
    .select({ capability: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.id, membershipCapabilitiesTable.membershipId),
    )
    .where(
      and(
        eq(membershipsTable.userId, MEMBER),
        eq(membershipsTable.teamId, TEAM_A),
      ),
    );
  assert.deepEqual(
    caps.map((c) => c.capability).sort(),
    [...capabilitiesForRole("owner")].sort(),
  );
});

test("a suspended account can't be handed the team", async () => {
  await seedTeam({ suspendOwner: true });
  await asUser(FOUNDER, async () => {
    await assert.rejects(
      () => transferTeamOwnership({ userId: OWNER, password: SEEDED_PW }),
      /suspended/,
    );
  });
  assert.equal(await founderOf(TEAM_A), FOUNDER);
});

test("somebody outside the team can't be handed it", async () => {
  await seedTeam();
  await asUser(FOUNDER, async () => {
    await assert.rejects(
      () => transferTeamOwnership({ userId: "nobody", password: SEEDED_PW }),
      /aren't a member of this team/,
    );
  });
  assert.equal(await founderOf(TEAM_A), FOUNDER);
});

/* ------------------------------------------------------------------ */
/* The crown actually moves                                            */
/* ------------------------------------------------------------------ */

/**
 * The column changing is not the point — every founder guard reading it is. So
 * this drives the invariant from the other side: after the transfer the NEW
 * founder is the unremovable one, and the old one is just an owner again.
 */
test("after the transfer, protection follows the crown", async () => {
  await seedTeam();
  await asUser(FOUNDER, () =>
    transferTeamOwnership({ userId: OWNER, password: SEEDED_PW }),
  );

  await asUser(OWNER, async () => {
    // The new founder is protected by the guard that used to protect FOUNDER.
    await assert.rejects(
      () =>
        runWithIdentity({ userId: FOUNDER, teamId: TEAM_A }, () =>
          removeMember(OWNER),
        ),
      /primary owner can't be removed/,
    );
    // And the ex-founder is now an ordinary owner: removable by the new one.
    await removeMember(FOUNDER);
  });
});

test("an API token can't hand the team over", async () => {
  await seedTeam();
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: FOUNDER,
          teamId: TEAM_A,
          token: {
            id: "tok_1",
            capabilities: ["view", "manage_team"],
            scope: null,
            instanceAdmin: false,
          },
        },
        () => transferTeamOwnership({ userId: OWNER, password: SEEDED_PW }),
      ),
    /API token can't access team ownership/,
  );
  assert.equal(await founderOf(TEAM_A), FOUNDER);
});
