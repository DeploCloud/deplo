import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { sha256Hex } from "../crypto";
import {
  avatarChoiceFromUrl,
  initialsFallbackUrl,
  avatarChoiceFromValue,
  avatarPreviewUrl,
  AVATAR_PACKS,
  AVATAR_VARIANTS,
  DEFAULT_PACK,
  facePath,
  faceParts,
  FALLBACK_SEED,
  INITIALS_PRESETS,
  isValidUserAvatarValue,
  packRow,
  packsFor,
  previewSeed,
  randomFaceValue,
} from "../apps/avatar-shared";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "./identity-test-helpers";
import { listMembers } from "./members/roster";
import {
  createTeam,
  getTeam,
  getTeamIdentity,
  listMyTeams,
  reorderMyTeams,
  updateTeamAvatar,
} from "./teams";
import { updateMyAvatar } from "./account";
import { setGravatarEnabled } from "./instance-settings/settings-store";
import { memberships as membershipsTable } from "../db/schema/control-plane/access-control";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { eq } from "drizzle-orm";

let db: TestDb;
let pg: PGlite;

const OWNER = "owner1";
const MEMBER = "member2";
const OUTSIDER = "outsider3";

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
  await as(OWNER, () => setGravatarEnabled(true));
});

const as = <T>(
  userId: string,
  fn: () => Promise<T>,
  teamId = TEAM_A,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

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

test("no uploaded picture resolves to a Gravatar address built from the email", async () => {
  const row = await memberRow(MEMBER);
  const expected = sha256Hex(`${MEMBER}@example.io`);
  assert.equal(
    row.avatarUrl,
    `https://gravatar.com/avatar/${expected}?s=160&d=404`,
  );
  // `d=404` is load-bearing: without it Gravatar paints a pattern instead of 404ing.
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
  assert.match(
    (await memberRow(MEMBER)).avatarUrl!,
    /^https:\/\/gravatar\.com\//,
  );
});

test("with the instance switch off, no Gravatar address is emitted anywhere", async () => {
  await as(OWNER, () => setGravatarEnabled(false));
  assert.equal((await memberRow(MEMBER)).avatarUrl, null);

  await as(MEMBER, () => updateMyAvatar(PICTURE));
  assert.equal((await memberRow(MEMBER)).avatarUrl, PICTURE);
});

test("nothing chosen leaves the letters to the component, like a team", async () => {
  await as(OWNER, () => setGravatarEnabled(false));
  assert.equal((await memberRow(MEMBER)).avatarUrl, null);
  assert.equal(
    initialsFallbackUrl("Ada Lovelace"),
    "/api/avatar/initials/default/Ada-Lovelace.svg",
  );
});

test("a preset face is stored as a marker and served from this instance", async () => {
  await as(MEMBER, () => updateMyAvatar("pixelbot:terminal:zoe"));
  assert.equal(
    (await memberRow(MEMBER)).avatarUrl,
    "/api/avatar/pixelbot/terminal/zoe.svg",
  );

  await as(MEMBER, () => updateMyAvatar("initials:electric:AL"));
  assert.equal(
    (await memberRow(MEMBER)).avatarUrl,
    "/api/avatar/initials/electric/AL.svg",
  );
});

test("initials is a choice, so the monogram survives an enabled Gravatar", async () => {
  await as(MEMBER, () => updateMyAvatar("initials"));
  assert.equal((await memberRow(MEMBER)).avatarUrl, null);
});

test("choosing Gravatar falls back to a face when the instance turns it off", async () => {
  await as(MEMBER, () => updateMyAvatar("gravatar"));
  assert.match(
    (await memberRow(MEMBER)).avatarUrl!,
    /^https:\/\/gravatar\.com\//,
  );

  await as(OWNER, () => setGravatarEnabled(false));
  assert.equal(
    (await memberRow(MEMBER)).avatarUrl,
    null,
    "their pick is off instance-wide, so nothing about them leaves the box",
  );
});

test("a seed that is not a plain word is refused, in and out of the URL", async () => {
  for (const bad of [
    "pixelbot:../../etc/passwd",
    "pixelbot:terminal:a b",
    "pixelbot:terminal",
    "pixelbot:nosuchpreset:zoe",
    "pixelbot:",
    `pixelbot:terminal:${"a".repeat(65)}`,
    "pixelbot:evil.com/x",
    "initials:terminal:AL",
    "initials:default:?",
    "nosuchstyle:electric:AL",
    "glyphs:electric:zoe",
    "pixelbot:default:zoe",
  ]) {
    await assert.rejects(
      as(MEMBER, () => updateMyAvatar(bad)),
      /Unsupported/i,
      `must refuse ${bad}`,
    );
  }
});

test("the picker reads back the source it just wrote", () => {
  for (const { style, preset } of AVATAR_PACKS) {
    const url = avatarPreviewUrl(`${style}:${preset}:zoe`);
    assert.equal(url, `/api/avatar/${style}/${preset}/zoe.svg`);
    assert.deepEqual(avatarChoiceFromUrl(url), {
      kind: "generated",
      style,
      preset,
      seed: "zoe",
    });
  }
  for (const { id } of INITIALS_PRESETS) {
    const url = avatarPreviewUrl(`initials:${id}:AL`);
    assert.equal(url, `/api/avatar/initials/${id}/AL.svg`);
    assert.deepEqual(avatarChoiceFromUrl(url), {
      kind: "generated",
      style: "initials",
      preset: id,
      seed: "AL",
    });
  }
  assert.deepEqual(avatarChoiceFromUrl(null), { kind: "initials" });
  assert.deepEqual(avatarChoiceFromUrl(PICTURE), {
    kind: "uploaded",
    src: PICTURE,
  });
  assert.deepEqual(avatarChoiceFromUrl("https://gravatar.com/avatar/abc?s=1"), {
    kind: "gravatar",
  });

  assert.deepEqual(avatarChoiceFromValue("planets:electric:zoe"), {
    kind: "generated",
    style: "planets",
    preset: "electric",
    seed: "zoe",
  });
  assert.deepEqual(avatarChoiceFromValue("gravatar"), { kind: "gravatar" });
  assert.deepEqual(avatarChoiceFromValue(PICTURE), {
    kind: "uploaded",
    src: PICTURE,
  });
  assert.deepEqual(avatarChoiceFromValue(null), { kind: "initials" });
});

test("a name with no picture falls back to its letters, drawn by DiceBear", () => {
  assert.equal(
    initialsFallbackUrl("Acme Corp"),
    "/api/avatar/initials/default/Acme-Corp.svg",
  );
  assert.notEqual(
    initialsFallbackUrl("Acme Corp"),
    initialsFallbackUrl("Acme Inc"),
  );
  assert.equal(
    initialsFallbackUrl("", null),
    "/api/avatar/initials/default/deplo.svg",
  );
});

test("the initials pack varies the palette, every other one is four fixed variants", () => {
  const initials = packRow(
    { style: "initials", preset: "default", label: "Initials" },
    "AL",
  );
  assert.equal(initials.length, 4);
  assert.deepEqual(
    initials.map((t) => t.preset),
    INITIALS_PRESETS.map((p) => p.id),
  );
  assert.equal(new Set(initials.map((t) => t.seed)).size, 1, "one seed only");
  assert.equal(initials.filter((t) => t.derived).length, 1);

  const faces = packRow(
    { style: "pixelbot", preset: "terminal", label: "Pixelbot Terminal" },
    "AL",
  );
  assert.equal(new Set(faces.map((t) => t.preset)).size, 1, "one palette only");
  assert.deepEqual(
    faces.map((t) => t.seed),
    [...AVATAR_VARIANTS],
  );
  assert.equal(faces.filter((t) => t.derived).length, 0);
});

test("a face nobody picked is random, and never the letters", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const value = randomFaceValue();
    assert.ok(isValidUserAvatarValue(value), value);
    assert.notEqual(
      faceParts(value)?.style,
      "initials",
      "the letters are a pick",
    );
    seen.add(value);
  }
  assert.ok(seen.size > 1, "one fixed face is not a random one");
});

test("no name yet: a person's row is still drawn, a team's is not", () => {
  assert.equal(previewSeed(""), FALLBACK_SEED);
  assert.equal(previewSeed("AL"), "AL");
  assert.equal(
    previewSeed("", true),
    "",
    "a team has no other pack to fall to",
  );
  assert.equal(
    facePath("initials", "default", previewSeed("")),
    "/api/avatar/initials/default/deplo.svg",
  );
  assert.deepEqual(
    packRow(DEFAULT_PACK, previewSeed("")).map((t) => t.seed),
    Array(4).fill(FALLBACK_SEED),
  );
});

test("nothing in a pack's row is generated from who is looking", () => {
  for (const pack of AVATAR_PACKS) {
    const mine = packRow(pack, "AL");
    const theirs = packRow(pack, "AL");
    assert.equal(mine.length, 4, `${pack.style} offers four`);
    assert.deepEqual(mine, theirs);
    if (pack.style !== "initials")
      assert.deepEqual(
        packRow(pack, "ZZ").map((t) => t.seed),
        mine.map((t) => t.seed),
        `${pack.style} does not read the name`,
      );
  }
});

test("a team picture needs manage_team, and the topbar identity carries it", async () => {
  await assert.rejects(
    as(MEMBER, () => updateTeamAvatar(PICTURE)),
    /.+/,
    "a plain member must not repaint the team",
  );

  await as(OWNER, () => updateTeamAvatar(PICTURE));
  assert.equal((await as(OWNER, () => getTeam())).avatarUrl, PICTURE);
  assert.equal((await as(MEMBER, () => getTeamIdentity())).avatarUrl, PICTURE);

  await as(OWNER, () => updateTeamAvatar(null));
  assert.equal((await as(MEMBER, () => getTeamIdentity())).avatarUrl, null);
});

test("a team picture is scoped to the ACTIVE team, never another one", async () => {
  await as(OUTSIDER, () => updateTeamAvatar(PICTURE), TEAM_B);

  const [a] = await db
    .select({ image: teamsTable.image })
    .from(teamsTable)
    .where(eq(teamsTable.id, TEAM_A));
  assert.equal(a!.image, null, "the other team's row must be untouched");
});

// Only the refusal half: createTeam ends in setActiveTeam, which the pglite harness cannot write.
test("a team picture is validated at creation, not only when it is changed", async () => {
  await assert.rejects(
    as(MEMBER, () => createTeam({ name: "Bad", image: "https://x.io/a.png" })),
    /Unsupported/i,
  );
});

test("a team may wear a generated picture, not a person's sources", async () => {
  await as(OWNER, () => updateTeamAvatar("initials:electric:Acme-Corp"));
  assert.equal(
    (await as(OWNER, () => getTeam())).avatarUrl,
    "/api/avatar/initials/electric/Acme-Corp.svg",
  );
  assert.deepEqual(
    packsFor(true).map((p) => p.style),
    ["initials"],
  );
  for (const bad of ["gravatar", "initials", "glyphs:default:nova"])
    await assert.rejects(
      as(OWNER, () => updateTeamAvatar(bad)),
      /Unsupported/i,
      `must refuse ${bad}`,
    );
  await as(OWNER, () => updateTeamAvatar(null));
  assert.equal((await as(OWNER, () => getTeam())).avatarUrl, null);
});

test("a team picture is refused the same values a person's is", async () => {
  await assert.rejects(
    as(OWNER, () => updateTeamAvatar("data:image/svg+xml;base64,PHN2Zz4=")),
    /Unsupported/i,
  );
});

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

  assert.deepEqual(
    (await as(OUTSIDER, () => listMyTeams(), TEAM_B)).map((t) => t.id),
    [TEAM_B],
    "another person's switcher is untouched",
  );
});

test("reorder ignores a team you are not in, and keeps the ones you left out", async () => {
  await joinTeamB("mbr_owner_b2");

  await as(OWNER, () => reorderMyTeams(["team_nope", TEAM_B, TEAM_B]));
  const after = (await as(OWNER, () => listMyTeams())).map((t) => t.id);
  assert.deepEqual(after, [TEAM_B, TEAM_A]);
});
