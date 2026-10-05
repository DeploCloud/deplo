import { test } from "node:test";
import assert from "node:assert/strict";

import { databaseClashes } from "./database-clash";

const servers = [
  {
    id: "a",
    name: "web",
    databaseHosts: [{ id: "d1", name: "main", host: "db-main" }],
  },
  {
    id: "b",
    name: "two",
    databaseHosts: [
      { id: "d2", name: "main", host: "db-main" },
      { id: "d3", name: "cache", host: "db-cache" },
    ],
  },
  {
    id: "c",
    name: "three",
    databaseHosts: [{ id: "d4", name: "shop", host: "db-main" }],
  },
  { id: "d", name: "older" },
];
const name = (id: string) => `box-${id}`;

test("three old servers on one server here: one sentence names every database", () => {
  assert.deepEqual(
    databaseClashes(servers, () => "x", name),
    [
      "The databases main (on web), main (on two) and shop (on three) all answer at db-main, so they cannot share box-x: choose another server here for web, two or three.",
    ],
  );
});

test("separate servers here, or an old server that is not copied, clash with nothing", () => {
  assert.deepEqual(
    databaseClashes(servers, (id) => (id === "c" ? null : id), name),
    [],
  );
  assert.deepEqual(
    databaseClashes(servers, (id) => (id === "b" ? "y" : "x"), name),
    [
      "The databases main (on web) and shop (on three) both answer at db-main, so they cannot share box-x: choose another server here for web or three.",
    ],
  );
});
