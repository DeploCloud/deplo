import { test } from "node:test";
import assert from "node:assert/strict";

import { matchTeams } from "./team-access";

const TEAMS = [
  { id: "t1", name: "Acme", slug: "acme" },
  { id: "t2", name: "Acme Labs", slug: "labs" },
  { id: "t3", name: "Globex", slug: "globex-eu" },
];

test("the team search matches a name or a slug, ignoring case", () => {
  const ids = (q: string) => matchTeams(TEAMS, q).map((t) => t.id);
  assert.deepEqual(ids("acme"), ["t1", "t2"]);
  assert.deepEqual(ids("LABS"), ["t2"]);
  assert.deepEqual(ids("eu"), ["t3"]);
  assert.deepEqual(ids("  "), ["t1", "t2", "t3"], "an empty search lists all");
  assert.deepEqual(ids("initech"), []);
});
