import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_TEAMS,
  filterPeople,
  linkGroups,
  linksCsv,
  linksTsv,
  mergePeople,
  notesFor,
  teamsOf,
} from "./people";
import type { Invite } from "./types";

const person = (over: Partial<Invite> = {}): Invite => ({
  email: "ada@acme.test",
  name: "Ada Lovelace",
  link: "https://deplo.test/join/x9k",
  outcome: "manual",
  message: "Send them this link to create their account.",
  sourceRole: "owner",
  hasAccount: false,
  avatarUrl: null,
  ...over,
});

const group = (name: string, people: Invite[]) => ({
  team: { name, avatarUrl: null },
  people,
});

test("somebody on three teams is one card with three teams and one link", () => {
  const merged = mergePeople([
    group("Acme", [person()]),
    group("Labs", [person()]),
    group("Web", [person()]),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0]!.landings.map((l) => l.team),
    ["Acme", "Labs", "Web"],
  );
  assert.deepEqual(linkGroups(merged[0]!), [
    { link: "https://deplo.test/join/x9k", teams: ["Acme", "Labs", "Web"] },
  ]);
  assert.deepEqual(teamsOf(merged), ["Acme", "Labs", "Web"]);
});

test("whoever has a link comes first, then alphabetically", () => {
  const merged = mergePeople([
    group("Acme", [
      person({ email: "zoe@acme.test", link: "https://deplo.test/join/z" }),
      person({ email: "carl@acme.test", link: null, outcome: "created" }),
      person({ email: "ada@acme.test", link: "https://deplo.test/join/a" }),
      person({ email: "bob@acme.test", link: null, outcome: "skipped" }),
    ]),
  ]);
  assert.deepEqual(
    merged.map((p) => p.email),
    ["ada@acme.test", "zoe@acme.test", "bob@acme.test", "carl@acme.test"],
  );
});

test("the team filter keeps whoever landed on it, the search reads both fields", () => {
  const merged = mergePeople([
    group("Acme", [person(), person({ email: "bob@acme.test", name: "Bob" })]),
    group("Labs", [person()]),
  ]);
  assert.deepEqual(
    filterPeople(merged, "", "Labs").map((p) => p.email),
    ["ada@acme.test"],
  );
  assert.equal(filterPeople(merged, "", ALL_TEAMS).length, 2);
  assert.deepEqual(
    filterPeople(merged, "LOVELACE", ALL_TEAMS).map((p) => p.email),
    ["ada@acme.test"],
  );
  assert.equal(filterPeople(merged, "bob", "Labs").length, 0);
});

test("a second link for one address stays a second block", () => {
  const merged = mergePeople([
    group("Acme", [person({ link: "https://deplo.test/join/one" })]),
    group("Labs", [person({ link: "https://deplo.test/join/two" })]),
  ]);
  assert.deepEqual(linkGroups(merged[0]!), [
    { link: "https://deplo.test/join/one", teams: ["Acme"] },
    { link: "https://deplo.test/join/two", teams: ["Labs"] },
  ]);
});

test("notes join the teams that say the same thing, and drop the names when alone", () => {
  const alone = mergePeople([
    group("Acme", [
      person({ link: null, outcome: "created", message: "Added to the team." }),
    ]),
  ]);
  assert.deepEqual(notesFor(alone[0]!), [
    { teams: [], message: "Added to the team." },
  ]);

  const mixed = mergePeople([
    group("Acme", [person()]),
    group("Labs", [
      person({ link: null, outcome: "skipped", message: "Already a member." }),
    ]),
    group("Web", [
      person({ link: null, outcome: "skipped", message: "Already a member." }),
    ]),
    group("Ops", [
      person({ link: null, outcome: "failed", message: "Could not invite." }),
    ]),
  ]);
  assert.deepEqual(notesFor(mixed[0]!), [
    { teams: ["Labs", "Web"], message: "Already a member." },
    { teams: ["Ops"], message: "Could not invite." },
  ]);
});

test("the csv quotes a name with a comma and still lists whoever has no link", () => {
  const merged = mergePeople([
    group("Acme", [person({ name: "Lovelace, Ada" })]),
    group("Labs", [person({ name: "Lovelace, Ada" })]),
    group("Acme", [
      person({
        email: "carl@acme.test",
        name: "Carl",
        link: null,
        outcome: "created",
        message: "Added to the team.",
      }),
    ]),
  ]);
  assert.equal(
    linksCsv(merged),
    [
      "email,name,teams,link",
      'ada@acme.test,"Lovelace, Ada",Acme;Labs,https://deplo.test/join/x9k',
      "carl@acme.test,Carl,Acme,",
    ].join("\n"),
  );
  assert.equal(linksTsv(merged), "ada@acme.test\thttps://deplo.test/join/x9k");
});
