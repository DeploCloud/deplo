import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { MigrationTree, visible, type PortConflict } from "./migration-tree";
import type {
  Placement,
  PlanProject,
  PlanService,
  ServerChoice,
} from "./types";

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
 * That is also how the bulk row is tested: its placeholder is visible exactly
 * when the rows disagree and it therefore has no value to show.
 */

function service(
  over: Partial<PlanService> & { sourceId: string },
): PlanService {
  return {
    kind: "application",
    name: over.sourceId,
    targetKind: "app",
    status: "new",
    sourceServerId: "",
    buildsFromSource: true,
    engine: null,
    exposedPort: null,
    domains: [],
    logo: null,
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
          service({
            sourceId: "s-web",
            domains: ["blink.acme.com"],
            notes: ["Published host ports on Dokploy."],
          }),
          service({ sourceId: "s-api" }),
          service({
            sourceId: "s-db",
            targetKind: "database",
            kind: "postgres",
            engine: "postgres",
            buildsFromSource: false,
            exposedPort: 5432,
            domains: [],
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
          service({
            sourceId: "s-stack",
            kind: "compose",
            buildsFromSource: false,
          }),
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
    projects?: PlanProject[];
    buildServers?: ServerChoice[];
    placements?: Record<string, Placement>;
    portConflicts?: Record<string, PortConflict>;
    showPorts?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(MigrationTree, {
        projects: opts.projects ?? PROJECTS,
        chosen: new Set(chosen),
        onChange: () => {},
        servers: SERVERS,
        // Same list as the run column unless a test says otherwise: a fleet with
        // no build-only host is the ordinary case.
        buildServers: opts.buildServers ?? SERVERS,
        placements: opts.placements ?? homePlacements(),
        onPlacementsChange: () => {},
        portConflicts: opts.portConflicts ?? {},
        showPorts: opts.showPorts ?? true,
        allChosen: false,
        onToggleAll: () => {},
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

/** The bulk row, which now lives ABOVE the table instead of inside its head. */
function toolbar(html: string): string {
  const i = html.indexOf("min-w-[48rem]");
  return html.slice(0, i === -1 ? html.length : i);
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

test("a service's notes stay off the review entirely", () => {
  // They are not warnings - "this path now points at Deplo's files directory"
  // is a fact about how the import maps a thing, and a strip of yellow under
  // every second row is how a screen stops being read. They live in the report
  // the run leaves behind, and in the docs.
  const html = render(["s-web"]);
  assert.equal(html.includes("Published host ports"), false);
  assert.equal(html.includes("Deplo has no libsql engine"), false);
  // What DOES stay is the one-word verdict, which is a property of the row.
  assert.match(html, /Not supported/);
});

test("nothing marks a row as new, because everything here is", () => {
  // The status column says what is DIFFERENT about a row. A badge reading "New"
  // on nine rows out of ten is a column you have to look past to find the one
  // that says "Already here".
  const html = render([]);
  assert.equal(html.includes(">New<"), false);
});

test("something already in Deplo reads as a state, not a warning", () => {
  const already: PlanProject[] = [
    {
      sourceId: "p3",
      name: "Ported",
      exists: true,
      environments: [
        {
          sourceId: "e-p3",
          name: "production",
          exists: true,
          services: [service({ sourceId: "s-old", status: "exists" })],
        },
      ],
    },
  ];
  const html = render([], {
    projects: already,
    placements: { "s-old": { serverId: HOME, buildServerId: null } },
  });
  assert.match(html, /Already here/);
  // `info`, the blue token - never `warning`, which is what "there is a problem
  // with this row" means everywhere else in the app.
  const badge = html.match(/<[^>]*>Already here</);
  assert.ok(badge, "no Already here badge");
  const around = html.slice(
    Math.max(0, html.indexOf("Already here") - 400),
    html.indexOf("Already here"),
  );
  assert.ok(around.includes("--info"), "Already here is not on the info token");
  assert.equal(around.includes("--warning"), false);
});

/* ---- placement ------------------------------------------------------ */

test("every app gets a Runs on picker, including the ones nothing builds", () => {
  const html = render([]);
  for (const id of ["s-web", "s-api", "s-db", "s-stack"])
    assert.ok(html.includes(`id="imp-run-${id}"`), `no run picker for ${id}`);
  // Nothing Deplo can create, so nowhere to put it.
  assert.equal(html.includes(`id="imp-run-s-libsql"`), false);
});

test("no build-only host in the fleet means no build picker anywhere", () => {
  const html = render([]);
  assert.equal(html.includes("Build everything on"), false);
  assert.equal(html.includes(`id="imp-build-s-api"`), false);
});

test("one build-only host brings the build pickers back", () => {
  const html = render([], { buildServers: WITH_BUILDER });
  // The aria-label, not the placeholder: rows that agree on Automatic give the
  // bulk control a value, and a Select showing one renders no placeholder.
  assert.ok(
    toolbar(html).includes(`aria-label="Build everything on"`),
    "no bulk build control",
  );
  assert.ok(html.includes(`id="imp-build-s-api"`));
});

test("a service Deplo never compiles gets a dash, not a picker", () => {
  const html = render([], { buildServers: WITH_BUILDER });
  // A compose stack and a database both deploy as they are. The tooltip that
  // says WHY is not asserted here: Radix renders its content only once open.
  for (const id of ["s-stack", "s-db"]) {
    assert.equal(
      html.includes(`id="imp-build-${id}"`),
      false,
      `${id} got a picker`,
    );
    assert.ok(html.includes(`id="imp-nobuild-${id}"`), `${id} got no reason`);
  }
  assert.ok(html.includes(`id="imp-build-s-api"`), "a git app lost its picker");
});

test("the bulk control offers itself only when the rows disagree", () => {
  // Rows that agree give it a value, and a Radix Select showing a value renders
  // no placeholder - so the absence IS the assertion that it picked one up.
  const agree = toolbar(render([]));
  assert.equal(agree.includes("Place all on"), false);

  const split = toolbar(
    render([], {
      placements: {
        ...homePlacements(),
        "s-api": { serverId: OTHER, buildServerId: null },
      },
    }),
  );
  assert.match(split, /Place all on/);
});

test("the bulk row carries the select-all, and the table head is gone", () => {
  const html = render([]);
  assert.match(toolbar(html), /Select all/);
  // The header row that used to sit inside the table, with "Set all" down its
  // left and a caption over each picker, is not a column and is not there.
  assert.equal(html.includes("Set all"), false);
  assert.equal(html.includes(">Runs on<"), false);
});

/* ---- what a search leaves standing ---------------------------------- */

/** `visible` is the whole search: the markup around it is an Input and an X. */
function seen(query: string) {
  const v = visible(PROJECTS, query.toLowerCase().split(/\s+/).filter(Boolean));
  return {
    projects: [...v.projects].sort(),
    environments: [...v.environments].sort(),
    services: [...v.services].sort(),
  };
}

test("a hit keeps its ancestors, so nothing is stranded two levels down", () => {
  const v = seen("s-stg");
  assert.deepEqual(v.services, ["s-stg"]);
  assert.deepEqual(v.environments, ["e-stg"]);
  assert.deepEqual(v.projects, ["p1"]);
});

test("a project or environment that matches ITSELF keeps everything under it", () => {
  // Ticking a node has to keep meaning "everything in here".
  assert.deepEqual(seen("Blink").services, ["s-api", "s-db", "s-stg", "s-web"]);
  assert.deepEqual(seen("staging").services, ["s-stg"]);
});

test("an app is findable by its hostname, not only by its name", () => {
  // The name over there is often not the name you remember; the domain is.
  assert.deepEqual(seen("acme.com").services, ["s-web"]);
});

test("a kind finds every service of that kind at once", () => {
  assert.deepEqual(seen("postgres").services, ["s-db"]);
  assert.deepEqual(seen("compose").services, ["s-stack"]);
});

test("every term has to match, and nothing matching is empty", () => {
  // Two words describing a path: the project name plus the app's own.
  assert.deepEqual(seen("blink api").services, ["s-api"]);
  // Both terms against ONE service: "blink" is the project, "db" the app.
  assert.deepEqual(seen("blink db").services, ["s-db"]);
  assert.deepEqual(seen("nothing-like-this"), {
    projects: [],
    environments: [],
    services: [],
  });
});

/* ---- how a service is drawn ----------------------------------------- */

test("a database wears its engine's own mark, not a generic glyph", () => {
  const html = render([]);
  assert.match(html, /\/engines\/postgres\.svg/);
});

/**
 * A database's host port, which is the one thing on this screen that is not
 * about WHERE something goes.
 *
 * Quiet by default: a port nothing else wants is a fact, shown next to the
 * engine, not a question. It only becomes a control when it collides - and then
 * the row has to carry both answers, "publish it somewhere else" and "don't
 * publish it", because an import that silently drops the port is what this whole
 * strip exists to stop.
 */
test("a database says what it publishes, and only asks when that port is taken", () => {
  const clean = render(["s-db"]);
  assert.match(clean, /Publishes 5432/, "shown next to the engine");
  assert.equal(/imp-port-s-db/.test(clean), false, "and nothing to fill in");

  const clash = render(["s-db"], {
    placements: {
      ...homePlacements(),
      "s-db": { serverId: HOME, buildServerId: null, exposedPort: 25432 },
    },
    portConflicts: {
      "s-db": { takenPort: 5432, serverName: "eu-main-1", invalid: false },
    },
  });
  assert.match(clash, /Port 5432 is taken on eu-main-1\./);
  assert.match(clash, /Expose publicly/);
  // The alternative is already filled in: pressing Import is a working answer.
  assert.match(clash, /id="imp-port-s-db"[^>]*value="25432"/);
  // ...and the read-only chip is gone, because the number moved into the field.
  assert.equal(/Publishes 5432/.test(clash), false);

  // "Don't publish" is the same control turned off: no port field, and the row
  // no longer claims to publish anything.
  const off = render(["s-db"], {
    placements: {
      ...homePlacements(),
      "s-db": { serverId: HOME, buildServerId: null, exposedPort: null },
    },
    portConflicts: {
      "s-db": { takenPort: 5432, serverName: "eu-main-1", invalid: false },
    },
  });
  assert.equal(/imp-port-s-db/.test(off), false);
  assert.match(off, /Expose publicly/);

  // Without the publish-ports grant nothing about a port is shown at all - the
  // review says once, at the top, that these databases come over private.
  const noGrant = render(["s-db"], { showPorts: false });
  assert.equal(/Publishes 5432/.test(noGrant), false);
});
