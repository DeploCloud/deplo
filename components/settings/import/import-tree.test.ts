import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ImportTree } from "./import-tree";
import type { Placement, PlanProject, PlanService, ServerChoice } from "./types";

/**
 * The review tree's arithmetic, and which of its two placement columns exist.
 *
 * Everything else on that screen is markup, but the parent checkboxes are
 * DERIVED from the leaves - the whole reason the tree can be pruned per app -
 * and a half-ticked project that renders as fully ticked is a lie about what the
 * import is going to do. Rendered to static markup rather than driven in a
 * browser: the state lives in the props, so the HTML is the whole answer.
 *
 * What static markup CANNOT show is a Radix Select's chosen label - it resolves
 * that on the client - so the assertions here are about which controls exist and
 * what placeholder they fall back to, never about the text inside a closed one.
 */

function service(over: Partial<PlanService> & { sourceId: string }): PlanService {
  return {
    kind: "application",
    name: over.sourceId,
    targetKind: "app",
    status: "new",
    sourceServerId: "",
    buildsFromSource: true,
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
          service({
            sourceId: "s-db",
            targetKind: "database",
            kind: "postgres",
            buildsFromSource: false,
          }),
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
          service({ sourceId: "s-stack", kind: "compose", buildsFromSource: false }),
          service({
            sourceId: "s-libsql",
            kind: "libsql",
            targetKind: null,
            status: "unsupported",
            buildsFromSource: false,
            notes: ["Deplo has no libsql engine."],
          }),
        ],
      },
    ],
  },
];

const HOME = "srv-home";
const OTHER = "srv-other";
const BUILDER = "srv-builder";

const SERVERS: ServerChoice[] = [
  { id: HOME, name: "deplo host", isDeploHost: true },
  { id: OTHER, name: "eu-main-1" },
];
/** A fleet with somewhere to build that is not somewhere to run. */
const WITH_BUILDER: ServerChoice[] = [
  ...SERVERS,
  { id: BUILDER, name: "builder-1", buildOnly: true },
];

/** Every importable service on `HOME`, building automatically. */
function homePlacements(): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const p of PROJECTS)
    for (const e of p.environments)
      for (const s of e.services)
        if (s.status !== "unsupported")
          out[s.sourceId] = { serverId: HOME, buildServerId: null };
  return out;
}

function render(
  chosen: string[],
  opts: {
    buildServers?: ServerChoice[];
    placements?: Record<string, Placement>;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ImportTree, {
        projects: PROJECTS,
        chosen: new Set(chosen),
        onChange: () => {},
        servers: SERVERS,
        // Same list as the run column unless a test says otherwise: a fleet with
        // no build-only host is the ordinary case.
        buildServers: opts.buildServers ?? SERVERS,
        placements: opts.placements ?? homePlacements(),
        onPlacementsChange: () => {},
      }),
    ),
  );
}

/** The whole `<button role="checkbox">` tag carrying this id. */
function tagFor(html: string, id: string): string {
  const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  assert.ok(m, `no control with id ${id}`);
  return m[0];
}

function stateOf(html: string, id: string): string {
  const m = tagFor(html, id).match(/data-state="([a-z]+)"/);
  return m ? m[1] : "MISSING";
}

/** Everything above the scrolling body: the column captions and Set all. */
function header(html: string): string {
  return html.slice(0, html.indexOf("max-h-[28rem]"));
}

/* ---- selection ------------------------------------------------------ */

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

/* ---- placement ------------------------------------------------------ */

test("every app gets a Runs on picker, including the ones nothing builds", () => {
  const html = render([]);
  for (const id of ["s-web", "s-api", "s-db", "s-stack"])
    assert.ok(html.includes(`id="imp-run-${id}"`), `no run picker for ${id}`);
  // Nothing Deplo can create, so nowhere to put it.
  assert.equal(html.includes(`id="imp-run-s-libsql"`), false);
});

test("no build-only host in the fleet means no Build column at all", () => {
  const html = render([]);
  assert.equal(html.includes("Runs on"), true);
  assert.equal(html.includes(">Build<"), false);
  assert.equal(html.includes(`id="imp-build-s-api"`), false);
});

test("one build-only host brings the column back", () => {
  const html = render([], { buildServers: WITH_BUILDER });
  assert.equal(html.includes(">Build<"), true);
  assert.ok(html.includes(`id="imp-build-s-api"`));
});

test("a service Deplo never compiles gets a dash, not a picker", () => {
  const html = render([], { buildServers: WITH_BUILDER });
  // A compose stack and a database both deploy as they are. The tooltip that
  // says WHY is not asserted here: Radix renders its content only once open.
  for (const id of ["s-stack", "s-db"]) {
    assert.equal(html.includes(`id="imp-build-${id}"`), false, `${id} got a picker`);
    assert.ok(html.includes(`id="imp-nobuild-${id}"`), `${id} got no reason`);
  }
  assert.ok(html.includes(`id="imp-build-s-api"`), "a git app lost its picker");
});

test("Set all reads Mixed only when the rows actually disagree", () => {
  const agree = header(render([]));
  assert.equal(agree.includes("Mixed"), false);

  const split = header(
    render([], {
      placements: { ...homePlacements(), "s-api": { serverId: OTHER, buildServerId: null } },
    }),
  );
  assert.match(split, /Mixed/);
});
