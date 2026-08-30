// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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

test("the overview href points at the thing itself, not its logs", () => {
  assert.equal(logTargetOverviewHref("app:my-app"), "/apps/my-app");
  assert.equal(logTargetOverviewHref("db:abc"), "/storage/databases/abc");
  for (const bad of ["", "app:", "nope"]) {
    assert.equal(logTargetOverviewHref(bad), "/");
  }
});

/* ------------------------------------------------------------------ */
/* The tree the picker draws                                           */
/* ------------------------------------------------------------------ */

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
  // Its folder is one the caller holds no grant on, so `listFolders` never
  // returned it. The app must still be pickable.
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

// A heading with nothing readable under it is a dead end in a picker: the empty
// project, its environment, and the project folder nobody deployed into are all
// gone from the list above.
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
  // Nothing at all still answers with a list, not a crash.
  assert.deepEqual(buildLogTree([], TREE_CTX), []);
});

test("typing keeps an app's headings, and a heading keeps its apps", () => {
  const rows = buildLogTree(TREE_TARGETS, TREE_CTX);
  const row = (key: string) => rows.find((r) => r.key === key)!;

  // An app answers for its ancestors…
  assert.equal(logTreeMatches(row("grp:project:prc_a"), "staging"), true);
  assert.equal(logTreeMatches(row("grp:folder:fld_mkt"), "landing"), true);
  // …and an ancestor answers for its apps.
  assert.equal(logTreeMatches(row("app:api"), "acme production"), true);
  assert.equal(logTreeMatches(row("app:landing"), "marketing"), true);
  // A sibling branch is not dragged along.
  assert.equal(logTreeMatches(row("grp:project:prc_a"), "landing"), false);
  assert.equal(logTreeMatches(row("app:api"), "marketing"), false);
  // The empty query matches everything, and matching is case-insensitive and
  // term by term.
  assert.equal(logTreeMatches(row("app:api"), ""), true);
  assert.equal(logTreeMatches(row("db:db_main"), "MAIN postgres"), true);
  assert.equal(logTreeMatches(row("db:db_main"), "main mysql"), false);
});
