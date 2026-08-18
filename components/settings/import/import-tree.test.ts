import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ImportTree } from "./import-tree";
import type { PlanProject, PlanService } from "./types";

/**
 * The review tree's arithmetic.
 *
 * Everything else on that screen is markup, but the parent checkboxes are
 * DERIVED from the leaves - the whole reason the tree can be pruned per app -
 * and a half-ticked project that renders as fully ticked is a lie about what the
 * import is going to do. Rendered to static markup rather than driven in a
 * browser: the state lives in the props, so the HTML is the whole answer.
 */

function service(over: Partial<PlanService> & { sourceId: string }): PlanService {
  return {
    kind: "application",
    name: over.sourceId,
    targetKind: "app",
    status: "new",
    sourceServerId: "",
    domains: [],
    notes: [],
    ...over,
  };
}

const PROJECTS: PlanProject[] = [
  {
    sourceId: "p1",
    name: "Blink",
    exists: false,
    environments: [
      {
        sourceId: "e-prod",
        name: "production",
        exists: false,
        services: [
          service({ sourceId: "s-web", notes: ["Published host ports on Dokploy."] }),
          service({ sourceId: "s-api" }),
          service({ sourceId: "s-db", targetKind: "database", kind: "postgres" }),
        ],
      },
      {
        sourceId: "e-stg",
        name: "staging",
        exists: false,
        services: [service({ sourceId: "s-stg" })],
      },
    ],
  },
  {
    sourceId: "p2",
    name: "Side projects",
    exists: false,
    environments: [
      {
        sourceId: "e-other",
        name: "production",
        exists: false,
        services: [
          service({ sourceId: "s-stack", kind: "compose" }),
          service({
            sourceId: "s-libsql",
            kind: "libsql",
            targetKind: null,
            status: "unsupported",
            notes: ["Deplo has no libsql engine."],
          }),
        ],
      },
    ],
  },
];

function render(chosen: string[]): string {
  return renderToStaticMarkup(
    createElement(ImportTree, {
      projects: PROJECTS,
      chosen: new Set(chosen),
      onChange: () => {},
    }),
  );
}

/** The whole `<button role="checkbox">` tag carrying this id. */
function tagFor(html: string, id: string): string {
  const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  assert.ok(m, `no checkbox with id ${id}`);
  return m[0];
}

function stateOf(html: string, id: string): string {
  const m = tagFor(html, id).match(/data-state="([a-z]+)"/);
  return m ? m[1] : "MISSING";
}

test("nothing picked leaves every box off", () => {
  const html = render([]);
  assert.equal(stateOf(html, "imp-p-p1"), "unchecked");
  assert.equal(stateOf(html, "imp-e-e-prod"), "unchecked");
  assert.match(html, />0 of 4 selected</);
});

test("every service picked reads as a full project, not a partial one", () => {
  const html = render(["s-web", "s-api", "s-db", "s-stg"]);
  assert.equal(stateOf(html, "imp-p-p1"), "checked");
  assert.equal(stateOf(html, "imp-e-e-prod"), "checked");
  assert.equal(stateOf(html, "imp-e-e-stg"), "checked");
  assert.match(html, />4 of 4 selected</);
});

test("dropping one service makes its project and environment half", () => {
  const html = render(["s-web", "s-db", "s-stg"]);
  assert.equal(stateOf(html, "imp-p-p1"), "indeterminate");
  assert.equal(stateOf(html, "imp-e-e-prod"), "indeterminate");
  // The environment nothing was taken from stays fully on.
  assert.equal(stateOf(html, "imp-e-e-stg"), "checked");
  assert.match(html, />3 of 4 selected</);
  assert.match(html, />2 of 3 selected</);
});

test("an engine Deplo does not have can never be picked, and never counts", () => {
  const html = render(["s-stack"]);
  assert.equal(stateOf(html, "imp-s-s-libsql"), "unchecked");
  assert.match(tagFor(html, "imp-s-s-libsql"), /disabled/);
  // One compose plus one unsupported is ONE pickable, so the project is full.
  assert.equal(stateOf(html, "imp-p-p2"), "checked");
  assert.match(html, />1 of 1 selected</);
});

test("a service's notes are warnings on screen, not grey small print", () => {
  const html = render(["s-web"]);
  // The note's own row carries the warning token - the point of the change is
  // that these stopped being `text-muted-foreground` under each service.
  const before = html.slice(0, html.indexOf("Published host ports"));
  assert.ok(
    before.slice(-1500).includes("text-warning"),
    "the note is not rendered as a warning",
  );
  assert.match(html, /Not supported/);
});
