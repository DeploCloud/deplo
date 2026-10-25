import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alertFingerprint,
  exploitedLine,
  securitySubjects,
  subjectHref,
  subjectsTitle,
} from "./subjects";

const subjects = securitySubjects(
  [
    {
      id: "a1",
      name: "web",
      slug: "web",
      securityUpdates: { count: 2, exploited: 0 },
    },
    {
      id: "a2",
      name: "blog",
      slug: "blog",
      securityUpdates: { count: 1, exploited: 1 },
    },
    { id: "a3", name: "clean", slug: "clean" },
  ],
  [{ id: "db1", name: "main" }],
  new Map([["db1", { count: 3, exploited: 0 }]]),
);

test("securitySubjects: only what needs updates, attacks first", () => {
  assert.deepEqual(
    subjects.map((s) => s.name),
    ["blog", "main", "web"],
  );
  assert.equal(subjectHref(subjects[0]), "/apps/blog");
  assert.equal(subjectHref(subjects[1]), "/storage/databases/db1");
});

test("the copy counts apps and databases in plain words", () => {
  assert.equal(
    subjectsTitle(subjects),
    "2 apps and 1 database need security updates",
  );
  assert.equal(
    subjectsTitle(subjects.slice(0, 1)),
    "1 app needs security updates",
  );
  assert.equal(
    exploitedLine(subjects),
    "1 of them runs something already being used in attacks.",
  );
  assert.equal(exploitedLine(subjects.slice(1)), null);
});

test("alertFingerprint moves when anything new shows up", () => {
  const a = alertFingerprint(subjects);
  assert.equal(
    alertFingerprint([...subjects].reverse()),
    a,
    "order does not matter",
  );
  assert.notEqual(
    alertFingerprint([{ ...subjects[0], count: 2 }, ...subjects.slice(1)]),
    a,
  );
});
