import { test } from "node:test";
import assert from "node:assert/strict";

import { nextSort, sortRows, type SortValue } from "./table-sort";

type Row = { name: string; mem: number | null; status: string };
const ROWS: Row[] = [
  { name: "web-10", mem: 512, status: "running" },
  { name: "web-2", mem: null, status: "stopped" },
  { name: "api", mem: 2048, status: "running" },
  { name: "Worker", mem: 64, status: "error" },
];
const names = (rows: Row[]) => rows.map((r) => r.name);

test("a number column opens biggest first, then reverses; an empty value stays last both ways", () => {
  const mem = (r: Row): SortValue => r.mem;
  const first = nextSort(null, "mem", ROWS, mem);
  assert.deepEqual(first, { key: "mem", dir: "desc" });
  assert.deepEqual(names(sortRows(ROWS, mem, first.dir)), [
    "api",
    "web-10",
    "Worker",
    "web-2",
  ]);
  const second = nextSort(first, "mem", ROWS, mem);
  assert.equal(second.dir, "asc");
  assert.deepEqual(names(sortRows(ROWS, mem, second.dir)), [
    "Worker",
    "web-10",
    "api",
    "web-2",
  ]);
});

test("a text column opens from A, reads numbers inside names as numbers and ignores case", () => {
  const name = (r: Row): SortValue => r.name;
  assert.equal(nextSort(null, "name", ROWS, name).dir, "asc");
  assert.deepEqual(names(sortRows(ROWS, name, "asc")), [
    "api",
    "web-2",
    "web-10",
    "Worker",
  ]);
});

test("sorting by status groups the rows and keeps their order inside a group", () => {
  const status = (r: Row): SortValue => r.status;
  assert.deepEqual(names(sortRows(ROWS, status, "asc")), [
    "Worker",
    "web-10",
    "api",
    "web-2",
  ]);
});

test("another column starts over at its own first direction", () => {
  const name = (r: Row): SortValue => r.name;
  assert.deepEqual(nextSort({ key: "mem", dir: "asc" }, "name", ROWS, name), {
    key: "name",
    dir: "asc",
  });
});
