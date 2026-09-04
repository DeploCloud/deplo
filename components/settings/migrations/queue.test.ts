import test from "node:test";
import assert from "node:assert/strict";

import {
  addTeam,
  teamsAfter,
  uncoveredTeams,
  type QueuedTeam,
  type SourceTeam,
} from "./queue";

const team = (over: Partial<SourceTeam> = {}): SourceTeam => ({
  platform: "coolify",
  teamId: "1",
  teamName: "Acme Corp",
  teamAvatarUrl: null,
  otherTeams: null,
  ...over,
});

const added = (q: QueuedTeam[], t: SourceTeam, key: string): QueuedTeam[] => {
  const res = addTeam(q, t, key);
  assert.equal(res.error, null);
  return res.queue ?? [];
};

test("a token becomes a team on the list", () => {
  const q = added([], team(), "tok-a");
  assert.deepEqual(q, [
    {
      apiKey: "tok-a",
      sourceTeamId: "1",
      name: "Acme Corp",
      avatarUrl: null,
      status: "waiting",
    },
  ]);
});

// The row draws the panel's own picture for that team, so it has to survive the
// trip from `identifyMigrationSource` onto the list.
test("the team's picture rides onto its row", () => {
  const logo = "data:image/webp;base64,AAAA";
  const q = added([], team({ teamAvatarUrl: logo }), "tok-a");
  assert.equal(q[0]?.avatarUrl, logo);
});

// Two tokens of ONE team would import that team twice.
test("the same team twice is refused by its id", () => {
  const q = added([], team(), "tok-a");
  const again = addTeam(q, team({ teamName: "Acme" }), "tok-b");
  assert.match(again.error ?? "", /already on the list/);
});

// A panel that will not name its teams leaves the key as the only tell.
test("the same key twice is refused even with no id", () => {
  const q = added([], team({ teamId: null, teamName: null }), "tok-a");
  assert.equal(q[0]?.name, "that team");
  assert.match(addTeam(q, team({ teamId: null }), "tok-a").error ?? "", /key/);
  // A second team of the same nameless panel is still a second team.
  assert.equal(addTeam(q, team({ teamId: null }), "tok-b").error, null);
});

test("a blank key is not a team", () => {
  assert.match(addTeam([], team(), "  ").error ?? "", /Paste the key/);
});

// Dokploy names the organizations a key does not cover; Coolify cannot, and
// answers null - which is not the same fact as "nothing is missing".
test("only the teams no token covers are named", () => {
  const q = added([], team({ teamName: "Acme Corp" }), "tok-a");
  assert.deepEqual(uncoveredTeams(["Acme Corp", "Ops", "Marketing"], q), [
    "Ops",
    "Marketing",
  ]);
  assert.deepEqual(uncoveredTeams(["acme corp "], q), []);
  assert.deepEqual(uncoveredTeams(null, q), []);
});

// What decides `keepSources` on a run, and what holds the takeover.
test("the teams still behind this one are counted", () => {
  const q = [team(), team({ teamId: "2" }), team({ teamId: "3" })].reduce(
    (acc, t, i) => added(acc, t, `tok-${i}`),
    [] as QueuedTeam[],
  );
  assert.equal(teamsAfter(q, 0), 2);
  assert.equal(teamsAfter(q, 2), 0);
  assert.equal(teamsAfter(q, 9), 0);
  assert.equal(teamsAfter([], 0), 0);
});
