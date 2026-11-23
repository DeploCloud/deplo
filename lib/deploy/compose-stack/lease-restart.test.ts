import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDoc, labelsOf, type Svc } from "./stack-test-helpers";

const STACK = `
services:
  web:
    image: nginx
  db:
    image: postgres:17
    restart: always
  migrate:
    image: acme/migrate
  worker:
    image: acme/worker
    restart: "no"
    depends_on:
      migrate:
        condition: service_completed_successfully
`;

type R = Svc & { restart?: string };

test("under a lease, a service with no policy is kept up, a written one wins", () => {
  const doc = buildDoc(STACK, { underLease: true });
  const s = doc.services as Record<string, R>;
  for (const name of ["web", "db", "migrate", "worker"])
    assert.equal(
      s[name].restart ?? "no",
      "no",
      `${name} keeps Docker's policy off`,
    );
  assert.ok(labelsOf(s.web).includes("deplo.restart=unless-stopped"));
  assert.ok(labelsOf(s.db).includes("deplo.restart=always"));
  assert.ok(
    !labelsOf(s.worker).some((l) => l.startsWith("deplo.restart=")),
    "a written no stays",
  );
  assert.ok(
    !labelsOf(s.migrate).some((l) => l.startsWith("deplo.restart=")),
    "a step others wait to finish runs once",
  );
});

test("off a lease, nothing about restarts changes", () => {
  const doc = buildDoc(STACK);
  const s = doc.services as Record<string, R>;
  assert.equal(s.web.restart, undefined);
  assert.equal(s.db.restart, "always");
  assert.ok(!labelsOf(s.web).some((l) => l.startsWith("deplo.restart=")));
});
