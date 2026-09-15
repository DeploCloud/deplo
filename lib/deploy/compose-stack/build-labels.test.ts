import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDoc, type BuildSvc } from "./stack-test-helpers";

test("a service with `build:` gets the tracking labels ON THE IMAGE (build.labels)", () => {
  const doc = buildDoc(`
services:
  web:
    build:
      context: ./web
  worker:
    build: ./worker
  db:
    image: postgres:16
`) as { services: Record<string, BuildSvc> };

  const web = doc.services.web.build;
  assert.ok(web && typeof web === "object");
  assert.deepEqual(web.labels, [
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=web",
  ]);

  const worker = doc.services.worker.build;
  assert.ok(worker && typeof worker === "object");
  assert.equal(worker.context, "./worker");
  assert.deepEqual(worker.labels, [
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=worker",
  ]);

  assert.equal(doc.services.db.build, undefined);
});

test("existing build.labels survive (map or list) and colliding keys are replaced", () => {
  const doc = buildDoc(`
services:
  web:
    build:
      context: .
      labels:
        com.example.team: platform
        deplo.slug: stale
`) as { services: Record<string, BuildSvc> };

  const build = doc.services.web.build;
  assert.ok(build && typeof build === "object");
  assert.deepEqual(build.labels, [
    "com.example.team=platform",
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=web",
  ]);
});
