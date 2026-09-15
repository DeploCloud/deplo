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
  const q = added([], team(), "tok-a", teams);
  assert.deepEqual(q[0]?.target, { kind: "existing", teamId: "team_1" });
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

test("a row starts with no picture of its own", () => {
  const q = added([], team(), "tok-a");
  assert.equal(q[0]?.image, null);
});

test("the same team twice is refused by its id", () => {
  const q = added([], team(), "tok-a");
  const again = addTeam(q, team({ teamName: "Acme" }), "tok-b");
  assert.match(again.error ?? "", /already on the list/);
});

test("the same key twice is refused even with no id", () => {
  const q = added([], team({ teamId: null, teamName: null }), "tok-a");
  assert.equal(q[0]?.name, "");
  assert.match(addTeam(q, team({ teamId: null }), "tok-a").error ?? "", /key/);
  assert.equal(addTeam(q, team({ teamId: null }), "tok-b").error, null);
});

test("a blank key is not a team", () => {
  assert.match(addTeam([], team(), "  ").error ?? "", /Paste the key/);
});

test("only the teams no token covers are named", () => {
  const q = added([], team({ teamName: "Acme Corp" }), "tok-a");
  assert.deepEqual(uncoveredTeams(["Acme Corp", "Ops", "Marketing"], q), [
    "Ops",
    "Marketing",
  ]);
  assert.deepEqual(uncoveredTeams(["acme corp "], q), []);
  assert.deepEqual(uncoveredTeams(null, q), []);
});

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
