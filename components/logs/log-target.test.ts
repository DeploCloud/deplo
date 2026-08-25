import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOG_CHOOSER_HREF,
  logTargetHref,
  logTargetMatches,
  logTargetOverviewHref,
  resolveLogTarget,
  type LogTarget,
} from "./log-target";

const api: LogTarget = {
  key: "app:api",
  kind: "app",
  name: "API",
  detail: "api",
  status: "active",
  logo: null,
};
const db: LogTarget = {
  key: "db:db_main",
  kind: "database",
  name: "main-db",
  detail: "postgres",
  status: "running",
  logo: null,
  type: "postgres",
};
const TARGETS = [api, db];

test("the url wins over the remembered target", () => {
  assert.equal(
    resolveLogTarget(TARGETS, { app: "api", cookie: "db:db_main" }),
    api,
  );
  assert.equal(resolveLogTarget(TARGETS, { db: "db_main" }), db);
});

test("the cookie is used when the url names nothing", () => {
  assert.equal(resolveLogTarget(TARGETS, { cookie: "app:api" }), api);
});

test("pick beats both and lands on the chooser", () => {
  assert.equal(
    resolveLogTarget(TARGETS, { pick: "1", app: "api", cookie: "app:api" }),
    null,
  );
});

// The one piece of security-shaped logic here: a remembered target the caller
// may no longer read is simply absent from the list, and absence is refusal.
test("a target missing from the readable list resolves to nothing", () => {
  assert.equal(resolveLogTarget(TARGETS, { cookie: "app:deleted" }), null);
  assert.equal(resolveLogTarget(TARGETS, { app: "someone-elses-app" }), null);
  assert.equal(resolveLogTarget([], { cookie: "app:api" }), null);
});

test("a malformed cookie is ignored, never thrown", () => {
  for (const cookie of ["", "   ", "app:", "nonsense", "x".repeat(4096)]) {
    assert.equal(resolveLogTarget(TARGETS, { cookie }), null);
  }
});

test("a repeated search param takes its first value", () => {
  assert.equal(resolveLogTarget(TARGETS, { app: ["api", "web"] }), api);
});

test("hrefs name the kind and encode the ref", () => {
  assert.equal(logTargetHref("app:my-app"), "/logs?app=my-app");
  assert.equal(logTargetHref("db:abc"), "/logs?db=abc");
  assert.equal(logTargetHref("app:a b/c"), "/logs?app=a%20b%2Fc");
  // Anything that is not a target key must not become a half-formed URL.
  for (const bad of ["", "app:", "nope", "db:"]) {
    assert.equal(logTargetHref(bad), "/logs");
  }
  assert.equal(LOG_CHOOSER_HREF, "/logs?pick=1");
});

test("typing matches the name or the detail, term by term", () => {
  assert.equal(logTargetMatches(api, ""), true);
  assert.equal(logTargetMatches(api, "AP"), true);
  assert.equal(logTargetMatches(db, "postgres"), true);
  assert.equal(logTargetMatches(db, "main postgres"), true);
  assert.equal(logTargetMatches(db, "main mysql"), false);
});

test("the overview href points at the thing itself, not its logs", () => {
  assert.equal(logTargetOverviewHref("app:my-app"), "/apps/my-app");
  assert.equal(logTargetOverviewHref("db:abc"), "/storage/databases/abc");
  for (const bad of ["", "app:", "nope"]) {
    assert.equal(logTargetOverviewHref(bad), "/");
  }
});
