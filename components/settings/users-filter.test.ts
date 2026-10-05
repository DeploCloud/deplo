import test from "node:test";
import assert from "node:assert/strict";

import type { GlobalUserDTO } from "@/lib/data/members/instance-users";
import { filterUsers } from "./users-filter";

type Filters = Parameters<typeof filterUsers>[1];

function u(over: Partial<GlobalUserDTO>): GlobalUserDTO {
  return {
    userId: "usr_x",
    username: "ada",
    name: "Ada",
    avatarColor: "#000000",
    avatarUrl: null,
    teamCount: 0,
    teams: [],
    isInstanceAdmin: false,
    isInstanceOwner: false,
    suspended: false,
    canExposePorts: false,
    canMountHostVolumes: false,
    createdAt: "2026-10-05T00:00:00.000Z",
    ...over,
  };
}

const USERS = [
  u({ userId: "a", teams: [{ slug: "acme", name: "Acme", avatarUrl: null }] }),
  u({
    userId: "b",
    teams: [{ slug: "labs", name: "Labs", avatarUrl: null }],
    suspended: true,
  }),
  u({ userId: "c", isInstanceAdmin: true }),
];
const ALL: Filters = { query: "", teams: [], access: [], statuses: [] };
const ids = (f: Partial<Filters>) =>
  filterUsers(USERS, { ...ALL, ...f }).map((x) => x.userId);

test("several teams widen the filter, a user in none drops out", () => {
  assert.deepEqual(ids({}), ["a", "b", "c"]);
  assert.deepEqual(ids({ teams: ["acme", "labs"] }), ["a", "b"]);
});

test("access and status narrow each other", () => {
  assert.deepEqual(ids({ access: ["member"], statuses: ["active"] }), ["a"]);
  assert.deepEqual(ids({ access: ["admin", "member"] }), ["a", "b", "c"]);
});
