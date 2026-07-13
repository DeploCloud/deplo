import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupRowsByProject,
  TOP_LEVEL,
  TOP_LEVEL_NAME,
} from "./env-grouping";

type Row = {
  key: string;
  app: { id: string; name: string; projectId: string | null };
};

const app = (id: string, name: string, projectId: string | null) => ({
  id,
  name,
  projectId,
});

const row = (key: string, a: Row["app"]): Row => ({ key, app: a });

const STOREFRONT = app("prj_1", "storefront", "prc_shop");
const API = app("prj_2", "api", "prc_shop");
const ADMIN = app("prj_3", "admin", "prc_tools");
const LOOSE = app("prj_4", "scratch", null);

const PROJECTS = [
  { id: "prc_shop", name: "Acme Shop", color: "#3b82f6" },
  { id: "prc_tools", name: "Internal Tools", color: null },
];

test("groups rows by project, then by app, counting the section's rows", () => {
  const sections = groupRowsByProject(
    [
      row("A", STOREFRONT),
      row("B", API),
      row("C", STOREFRONT),
      row("D", ADMIN),
    ],
    PROJECTS,
  );

  assert.deepEqual(
    sections.map((s) => [s.id, s.name, s.rowCount, s.apps.length]),
    [
      ["prc_shop", "Acme Shop", 3, 2],
      ["prc_tools", "Internal Tools", 1, 1],
    ],
  );
  assert.deepEqual(
    sections[0].apps.map((a) => [a.app.name, a.rows.map((r) => r.key)]),
    [
      ["storefront", ["A", "C"]],
      ["api", ["B"]],
    ],
  );
  assert.equal(sections[0].color, "#3b82f6");
  assert.equal(sections[1].color, null);
});

test("apps outside a project land in the Standalone section", () => {
  const sections = groupRowsByProject([row("A", LOOSE)], PROJECTS);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, TOP_LEVEL);
  assert.equal(sections[0].name, TOP_LEVEL_NAME);
  assert.equal(sections[0].color, null);
  assert.deepEqual(sections[0].apps[0].rows.map((r) => r.key), ["A"]);
});

test("sections follow the project order given, whatever order the rows arrive in", () => {
  // The rows lead with a Standalone app and the Internal Tools one; the sections
  // still come out in the team's Project order, with Standalone last.
  const sections = groupRowsByProject(
    [row("A", LOOSE), row("B", ADMIN), row("C", STOREFRONT)],
    PROJECTS,
  );
  assert.deepEqual(sections.map((s) => s.id), [
    "prc_shop",
    "prc_tools",
    TOP_LEVEL,
  ]);

  // Drag "Internal Tools" above "Acme Shop" (the caller re-orders `projects`)
  // and the sections follow — that IS the reorder.
  const dragged = groupRowsByProject(
    [row("A", LOOSE), row("B", ADMIN), row("C", STOREFRONT)],
    [PROJECTS[1], PROJECTS[0]],
  );
  assert.deepEqual(dragged.map((s) => s.id), [
    "prc_tools",
    "prc_shop",
    TOP_LEVEL,
  ]);
});

test("byName sorts the app cards A→Z; the sections keep the project order", () => {
  const sections = groupRowsByProject(
    [row("A", LOOSE), row("B", ADMIN), row("C", STOREFRONT), row("D", API)],
    // Project order is the user's, so even "sort by key" must not re-sort it
    // A→Z: Internal Tools was dragged first and stays first.
    [PROJECTS[1], PROJECTS[0]],
    { byName: true },
  );
  assert.deepEqual(sections.map((s) => s.name), [
    "Internal Tools",
    "Acme Shop",
    TOP_LEVEL_NAME,
  ]);
  assert.deepEqual(sections[1].apps.map((a) => a.app.name), [
    "api",
    "storefront",
  ]);
});

test("a project the caller never passed still keeps its apps on the page", () => {
  const orphan = app("prj_9", "ghost", "prc_gone");
  const sections = groupRowsByProject([row("A", orphan)], PROJECTS);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, "prc_gone");
  assert.equal(sections[0].name, "Project");
  assert.deepEqual(sections[0].apps[0].rows.map((r) => r.key), ["A"]);
});

test("an unranked project sits after the ordered ones, before Standalone", () => {
  const orphan = app("prj_9", "ghost", "prc_gone");
  const sections = groupRowsByProject(
    [row("A", LOOSE), row("B", orphan), row("C", ADMIN)],
    PROJECTS,
  );
  assert.deepEqual(sections.map((s) => s.id), [
    "prc_tools",
    "prc_gone",
    TOP_LEVEL,
  ]);
});

test("no rows means no sections — an empty card is never rendered", () => {
  assert.deepEqual(groupRowsByProject([], PROJECTS), []);
});
