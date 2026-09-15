import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOG_CHOOSER_HREF,
  buildLogTree,
  logTreeMatches,
  logTargetHref,
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
  for (const bad of ["", "app:", "nope", "db:"]) {
    assert.equal(logTargetHref(bad), "/logs");
  }
  assert.equal(LOG_CHOOSER_HREF, "/logs?pick=1");
});

test("the overview href points at the thing itself, not its logs", () => {
  assert.equal(logTargetOverviewHref("app:my-app"), "/apps/my-app");
  assert.equal(logTargetOverviewHref("db:abc"), "/storage/databases/abc");
  for (const bad of ["", "app:", "nope"]) {
    assert.equal(logTargetOverviewHref(bad), "/");
  }
});

function app(slug: string, where: Partial<LogTarget> = {}): LogTarget {
  return {
    key: `app:${slug}`,
    kind: "app",
    name: slug,
    detail: slug,
    status: "active",
    logo: null,
    ...where,
  };
}

const TREE_CTX = {
  projects: [
    { id: "prc_a", name: "Acme" },
    { id: "prc_empty", name: "Empty" },
  ],
  environments: [
    { id: "environ_prod", name: "Production", projectId: "prc_a" },
    { id: "environ_stage", name: "Staging", projectId: "prc_a" },
    { id: "environ_lonely", name: "Preview", projectId: "prc_empty" },
  ],
  folders: [
    { id: "fld_mkt", name: "Marketing" },
    { id: "fld_sub", name: "Landing pages", parentId: "fld_mkt" },
    { id: "fld_infra", name: "Infra", projectId: "prc_a" },
  ],
};

const TREE_TARGETS = [
  app("api", { projectId: "prc_a", environmentId: "environ_prod" }),
  app("web", { projectId: "prc_a", environmentId: "environ_prod" }),
  app("api-staging", { projectId: "prc_a", environmentId: "environ_stage" }),
  app("landing", { folderId: "fld_sub" }),
  app("orphan", { folderId: "fld_gone" }),
  app("scratch"),
  db,
];

test("the tree reads top down, the way the Overview is arranged", () => {
  assert.deepEqual(
    buildLogTree(TREE_TARGETS, TREE_CTX).map((r) => `${r.depth}:${r.key}`),
    [
      "0:grp:project:prc_a",
      "1:grp:environment:environ_prod",
      "2:app:api",
      "2:app:web",
      "1:grp:environment:environ_stage",
      "2:app:api-staging",
      "0:grp:folder:fld_mkt",
      "1:grp:folder:fld_sub",
      "2:app:landing",
      "0:app:orphan",
      "0:app:scratch",
      "0:grp:section:databases",
      "1:db:db_main",
    ],
  );
});

test("a branch with no readable target is not drawn", () => {
  const keys = buildLogTree(TREE_TARGETS, TREE_CTX).map((r) => r.key);
  for (const gone of [
    "grp:project:prc_empty",
    "grp:environment:environ_lonely",
    "grp:folder:fld_infra",
  ]) {
    assert.equal(keys.includes(gone), false, gone);
  }
});

test("no target is ever dropped, wherever it says it lives", () => {
  const rows = buildLogTree(TREE_TARGETS, TREE_CTX);
  for (const t of TREE_TARGETS) {
    assert.equal(
      rows.some((r) => r.target === t),
      true,
      t.key,
    );
  }
  assert.deepEqual(buildLogTree([], TREE_CTX), []);
});

test("typing keeps an app's headings, and a heading keeps its apps", () => {
  const rows = buildLogTree(TREE_TARGETS, TREE_CTX);
  const row = (key: string) => rows.find((r) => r.key === key)!;

  assert.equal(logTreeMatches(row("grp:project:prc_a"), "staging"), true);
  assert.equal(logTreeMatches(row("grp:folder:fld_mkt"), "landing"), true);
  assert.equal(logTreeMatches(row("app:api"), "acme production"), true);
  assert.equal(logTreeMatches(row("app:landing"), "marketing"), true);
  assert.equal(logTreeMatches(row("grp:project:prc_a"), "landing"), false);
  assert.equal(logTreeMatches(row("app:api"), "marketing"), false);
  assert.equal(logTreeMatches(row("app:api"), ""), true);
  assert.equal(logTreeMatches(row("db:db_main"), "MAIN postgres"), true);
  assert.equal(logTreeMatches(row("db:db_main"), "main mysql"), false);
});
