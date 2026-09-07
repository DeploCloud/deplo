import test from "node:test";
import assert from "node:assert/strict";

import {
  addTeam,
  defaultTarget,
  retarget,
  teamsAfter,
  uncoveredTeams,
  type QueuedTeam,
  type SourceTeam,
} from "./queue";

const team = (over: Partial<SourceTeam> = {}): SourceTeam => ({
  platform: "coolify",
  teamId: "1",
  teamName: "Acme Corp",
  otherTeams: null,
  ...over,
});

const added = (
  q: QueuedTeam[],
  t: SourceTeam,
  key: string,
  teams: { id: string; name: string }[] = [],
): QueuedTeam[] => {
  const res = addTeam(q, t, key, teams);
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
      image: null,
      target: { kind: "new" },
      status: "waiting",
    },
  ]);
});

// Where a source team lands unless somebody says otherwise: the team here of
// the same name, else one made for it - the separation they had over there.
test("a source team lands in its namesake, else in a team of its own", () => {
  const teams = [
    { id: "team_1", name: "Acme Corp" },
    { id: "team_2", name: "Ops" },
  ];
  assert.deepEqual(defaultTarget("acme corp ", teams), {
    kind: "existing",
    teamId: "team_1",
  });
  assert.deepEqual(defaultTarget("Marketing", teams), { kind: "new" });
  assert.deepEqual(defaultTarget("", teams), { kind: "new" });
  // The default rides onto the row.
  const q = added([], team(), "tok-a", teams);
  assert.deepEqual(q[0]?.target, { kind: "existing", teamId: "team_1" });
  // A team the panel would not name has no name here either, so it matches nobody.
  const nameless = added([], team({ teamId: null, teamName: null }), "tok-b", [
    { id: "team_9", name: "Nameless" },
  ]);
  assert.deepEqual(nameless[0]?.target, { kind: "new" });
});

test("a row can be pointed somewhere else, and the rest stay put", () => {
  const q = added(added([], team(), "tok-a"), team({ teamId: "2" }), "tok-b");
  const next = retarget(q, 1, { kind: "existing", teamId: "team_7" });
  assert.deepEqual(next[0]?.target, { kind: "new" });
  assert.deepEqual(next[1]?.target, { kind: "existing", teamId: "team_7" });
  assert.equal(next[1]?.apiKey, "tok-b");
});

// Only one of the two panels keeps a team picture, so a list carrying it would
// read differently depending on where a row came from. A new team starts on its
// initials and the operator picks from there.
test("a row starts with no picture of its own", () => {
  const q = added([], team(), "tok-a");
  assert.equal(q[0]?.image, null);
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
  // "" and not a placeholder: the list draws "An unnamed organization" from it.
  assert.equal(q[0]?.name, "");
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
