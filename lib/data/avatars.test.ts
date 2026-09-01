import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { sha256Hex } from "../crypto";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "./identity-test-helpers";
import { listMembers } from "./members";
import {
  createTeam,
  getTeam,
  getTeamIdentity,
  listMyTeams,
  reorderMyTeams,
  updateTeamAvatar,
} from "./teams";
import { updateMyAvatar } from "./account";
import { setGravatarEnabled } from "./instance-settings";
import {
  memberships as membershipsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { eq } from "drizzle-orm";

/**
 * Profile pictures, and the four things that would hurt if they slipped. The
 * instance-wide Gravatar switch is REAL: off must emit no address anywhere, not
 * merely hide it in one component.
 */

let db: TestDb;
let pg: PGlite;

const OWNER = "owner1";
const MEMBER = "member2";
const OUTSIDER = "outsider3";

/** A 1x1 WebP, as the picker would produce it. */
const PICTURE =
  "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4H";

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
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
      { id: OUTSIDER, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  // The switch is off on a fresh instance, so the tests below turn it on to have
  // anything to assert. That default has its own test in instance-settings.
  await as(OWNER, () => setGravatarEnabled(true));
});

const as = <T>(
  userId: string,
  fn: () => Promise<T>,
  teamId = TEAM_A,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

/** Put the owner in TEAM_B as well, so they have two teams to arrange. */
const joinTeamB = (id: string) =>
  db.insert(membershipsTable).values({
    id,
    userId: OWNER,
    teamId: TEAM_B,
    role: "member",
    createdAt: "2024-01-01T00:00:00.000Z",
  });

const memberRow = async (userId: string) =>
  (await as(OWNER, () => listMembers())).find((m) => m.userId === userId)!;

/* ------------------------------------------------------------------ */
/* A person's picture                                                  */
/* ------------------------------------------------------------------ */

test("no uploaded picture resolves to a Gravatar address built from the email", async () => {
  const row = await memberRow(MEMBER);
  // seedIdentity gives every user `<id>@example.io`.
  const expected = sha256Hex(`${MEMBER}@example.io`);
  assert.equal(
    row.avatarUrl,
    `https://gravatar.com/avatar/${expected}?s=160&d=404`,
  );
  // `d=404` is load-bearing: without it Gravatar paints a generated pattern over
  // everyone who never signed up, instead of 404ing into their monogram.
  assert.match(row.avatarUrl!, /d=404/);
});

test("the member list carries no email, only the derived address", async () => {
  const row = await memberRow(MEMBER);
  assert.ok(!("email" in row), "a member row must never carry an email");
  assert.ok(
    !JSON.stringify(row).includes("@example.io"),
    "no address may reach the DTO in any field",
  );
});

test("an uploaded picture wins over Gravatar, and clearing gives it back", async () => {
  await as(MEMBER, () => updateMyAvatar(PICTURE));
  assert.equal((await memberRow(MEMBER)).avatarUrl, PICTURE);

  await as(MEMBER, () => updateMyAvatar(null));
  assert.match(
    (await memberRow(MEMBER)).avatarUrl!,
    /^https:\/\/gravatar\.com\//,
  );
});

test("a value that is not a plain image data-URI is refused, and stores nothing", async () => {
  for (const bad of [
    "https://evil.example.com/face.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "/templates/n8n.svg",
    "javascript:alert(1)",
  ]) {
    await assert.rejects(
      as(MEMBER, () => updateMyAvatar(bad)),
      /Unsupported/i,
      `must refuse ${bad}`,
    );
  }
  // Still their Gravatar: nothing was written by any of those.
  assert.match(
    (await memberRow(MEMBER)).avatarUrl!,
    /^https:\/\/gravatar\.com\//,
  );
});

test("with the instance switch off, no Gravatar address is emitted anywhere", async () => {
  await as(OWNER, () => setGravatarEnabled(false));
  assert.equal((await memberRow(MEMBER)).avatarUrl, null);

  // An UPLOADED picture is unaffected - the switch is about talking to
  // gravatar.com, not about whether people may have a face.
  await as(MEMBER, () => updateMyAvatar(PICTURE));
  assert.equal((await memberRow(MEMBER)).avatarUrl, PICTURE);
});

/* ------------------------------------------------------------------ */
/* A team's picture                                                    */
/* ------------------------------------------------------------------ */

test("a team picture needs manage_team, and the topbar identity carries it", async () => {
  await assert.rejects(
    as(MEMBER, () => updateTeamAvatar(PICTURE)),
    /.+/,
    "a plain member must not repaint the team",
  );

  await as(OWNER, () => updateTeamAvatar(PICTURE));
  assert.equal((await as(OWNER, () => getTeam())).avatarUrl, PICTURE);
  // getTeamIdentity is what the topbar switcher's trigger renders - the most
  // seen avatar in the product - and it is a DIFFERENT query from getTeam.
  assert.equal((await as(MEMBER, () => getTeamIdentity())).avatarUrl, PICTURE);

  await as(OWNER, () => updateTeamAvatar(null));
  assert.equal((await as(MEMBER, () => getTeamIdentity())).avatarUrl, null);
});

test("a team picture is scoped to the ACTIVE team, never another one", async () => {
  // The outsider owns TEAM_B and holds manage_team there, so the capability gate
  // passes; only the team scoping stops TEAM_A being repainted.
  await as(OUTSIDER, () => updateTeamAvatar(PICTURE), TEAM_B);

  const [a] = await db
    .select({ image: teamsTable.image })
    .from(teamsTable)
    .where(eq(teamsTable.id, TEAM_A));
  assert.equal(a!.image, null, "the other team's row must be untouched");
});

// Only the refusal half: createTeam ends in `setActiveTeam`, which writes a
// cookie, and the pglite harness has no request scope to write it into.
test("a team picture is validated at creation, not only when it is changed", async () => {
  await assert.rejects(
    as(MEMBER, () => createTeam({ name: "Bad", image: "https://x.io/a.png" })),
    /Unsupported/i,
  );
});

test("a team picture is refused the same values a person's is", async () => {
  await assert.rejects(
    as(OWNER, () => updateTeamAvatar("data:image/svg+xml;base64,PHN2Zz4=")),
    /Unsupported/i,
  );
});

/* ------------------------------------------------------------------ */
/* The switcher order                                                  */
/* ------------------------------------------------------------------ */

test("the switcher order is per PERSON: dragging does not move anyone else's", async () => {
  await joinTeamB("mbr_owner_b");

  const before = (await as(OWNER, () => listMyTeams())).map((t) => t.id);
  assert.deepEqual([...before].sort(), [TEAM_A, TEAM_B].sort());

  const flipped = [...before].reverse();
  await as(OWNER, () => reorderMyTeams(flipped));
  assert.deepEqual(
    (await as(OWNER, () => listMyTeams())).map((t) => t.id),
    flipped,
  );

  // The outsider is in TEAM_B too and never dragged anything.
  assert.deepEqual(
    (await as(OUTSIDER, () => listMyTeams(), TEAM_B)).map((t) => t.id),
    [TEAM_B],
    "another person's switcher is untouched",
  );
});

test("reorder ignores a team you are not in, and keeps the ones you left out", async () => {
  await joinTeamB("mbr_owner_b2");

  // A foreign id and a duplicate: both dropped, and the team the client left out
  // still comes back rather than vanishing from the switcher.
  await as(OWNER, () => reorderMyTeams(["team_nope", TEAM_B, TEAM_B]));
  const after = (await as(OWNER, () => listMyTeams())).map((t) => t.id);
  assert.deepEqual(after, [TEAM_B, TEAM_A]);
});
