import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSchema, parse, validate } from "graphql";

import { NAV, SETTINGS_NAV, canSee } from "@/components/layout/nav-config";
import { ALL_CAPABILITIES } from "@/lib/types";
import { SEARCH_QUERY } from "./search-query";
import {
  APP_ACTIONS,
  teamPageEntries,
  countOwnedPages,
  matchOwnedPages,
  ownedPageEntries,
  DB_ACTIONS,
  PALETTE_APP_FLAGS,
  PALETTE_DB_FLAGS,
  appFrameEntries,
  dbFrameEntries,
  matchEntries,
  staticEntries,
  type Entry,
} from "./entries";

const APP = { id: "prj_1", slug: "blog", name: "Blog" };

test("every nav destination is in the catalogue, and no way-out row is", () => {
  const entries = staticEntries();
  const labels = new Set(entries.map((e) => e.label));
  for (const section of [...NAV, ...SETTINGS_NAV]) {
    for (const item of section.items) {
      if (item.back || item.disabledReason) {
        assert.ok(
          !entries.some(
            (e) =>
              e.run.kind === "href" &&
              e.id === `nav:${item.href}` &&
              e.label === item.label,
          ),
          `"${item.label}" is a way out of a menu, not a destination`,
        );
        continue;
      }
      assert.ok(labels.has(item.label), `missing "${item.label}"`);
    }
  }
});

test("labels and hints come from nav-config, never rewritten", () => {
  const byId = new Map(staticEntries().map((e) => [e.id, e]));
  for (const section of [...NAV, ...SETTINGS_NAV]) {
    for (const item of section.items) {
      if (item.back || item.disabledReason) continue;
      const entry = byId.get(`nav:${item.href}`);
      assert.ok(entry, item.href);
      assert.equal(entry.label, item.label);
      assert.equal(entry.hint, item.tooltip);
    }
  }
});

test("ids are unique - cmdk selects by value, a duplicate breaks Enter", () => {
  for (const [what, entries] of [
    ["static", staticEntries()],
    ["app frame", appFrameEntries(APP)],
    [
      "database frame",
      dbFrameEntries({ id: "db_1", name: "Main", type: "postgres" }),
    ],
  ] as [string, Entry[]][]) {
    const ids = entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${what} has a duplicate id`);
  }
});

test("capability gates hide what the viewer does not hold", () => {
  const logs = staticEntries().find((e) => e.label === "Logs");
  assert.ok(logs);
  assert.equal(canSee(logs, new Set(), false), false);
  assert.equal(canSee(logs, new Set(["view_logs"]), false), true);

  const admin = staticEntries().find((e) => e.requiresAdmin);
  assert.ok(admin);
  assert.equal(canSee(admin, new Set(ALL_CAPABILITIES), false), false);
  assert.equal(canSee(admin, new Set(ALL_CAPABILITIES), true), true);
});

test("matching prefers a label prefix, then a word, then the hint", () => {
  const ranked = matchEntries(staticEntries(), "deploy");
  assert.equal(
    ranked[0]?.label,
    "Deployments",
    "the label that starts with it",
  );
  assert.ok(
    ranked.some((e) => e.label === "Templates"),
    "a hint-only match still lands, further down",
  );

  // Separators fold, so two words find one hyphenated label.
  assert.ok(
    matchEntries(staticEntries(), "api tokens").some(
      (e) => e.label === "API tokens",
    ),
  );
  assert.deepEqual(matchEntries(staticEntries(), "xyzzy"), []);
  assert.equal(
    matchEntries(staticEntries(), "").length,
    staticEntries().length,
  );
});

test("an app frame carries its actions and stays inside its own app", () => {
  const entries = appFrameEntries(APP);
  const labels = entries.map((e) => e.label);
  for (const want of [
    "Redeploy",
    "Start",
    "Stop",
    "Reload",
    "Overview",
    "Logs",
    "Settings",
  ]) {
    assert.ok(labels.includes(want), `missing "${want}"`);
  }
  for (const entry of entries) {
    if (entry.run.kind !== "href") continue;
    assert.ok(
      entry.run.href.startsWith("/apps/blog"),
      `${entry.label} leaves the app: ${entry.run.href}`,
    );
  }
});

test("a feature switched off is not offered; switched on it is", () => {
  const closed = appFrameEntries(APP).map((e) => e.label);
  assert.ok(!closed.includes("Console"), "console is a dead end while off");
  assert.ok(!closed.includes("Cron jobs"));

  const open = appFrameEntries(APP, {
    ...PALETTE_APP_FLAGS,
    running: true,
    consoleEnabled: true,
    cronsEnabled: true,
  }).map((e) => e.label);
  assert.ok(open.includes("Console"));
  assert.ok(open.includes("Cron jobs"));
});

test("an app's own switches decide which of its pages are reachable", () => {
  // The palette used to assume every switch was off, so a console someone had
  // turned on could not be searched for at all.
  const pagesOf = (features: {
    pullRequests: boolean;
    cronJobs: boolean;
    console: boolean;
  }) =>
    ownedPageEntries(
      [{ id: "p1", slug: "blog", name: "blog", logo: null, features }],
      [],
    ).map((e) => e.label);

  const on = pagesOf({ pullRequests: true, cronJobs: true, console: true });
  for (const label of ["Console", "Cron jobs", "Pull requests"]) {
    assert.ok(on.includes(label), `"${label}" is switched on`);
  }

  const off = pagesOf({ pullRequests: false, cronJobs: false, console: false });
  for (const label of ["Console", "Cron jobs", "Pull requests"]) {
    assert.ok(!off.includes(label), `"${label}" is switched off`);
  }

  // Nothing said at all is the safe assumption, not an optimistic one.
  const unknown = ownedPageEntries(
    [{ id: "p2", slug: "quiet", name: "quiet", logo: null }],
    [],
  ).map((e) => e.label);
  assert.ok(!unknown.includes("Console"));
});

test("every action names a real capability and a real mutation", () => {
  const sdl = readFileSync("schema.graphql", "utf8");
  for (const action of [...APP_ACTIONS, ...DB_ACTIONS]) {
    assert.ok(
      (ALL_CAPABILITIES as readonly string[]).includes(action.requires),
      `${action.label}: ${action.requires} is not a capability`,
    );
    const name = action.query.match(/\{\s*(\w+)\(/)?.[1];
    assert.ok(name, `${action.label}: no mutation in the document`);
    assert.ok(
      new RegExp(`^\\s{2}${name}\\(`, "m").test(sdl),
      `${action.label}: \`${name}\` is not in schema.graphql`,
    );
  }
});

test("no two rows wear the same label", () => {
  // An alias earns its place by being a word nav-config does NOT use. Repeating
  // one just puts the same row on screen twice.
  const labels = staticEntries().map((e) => e.label);
  const twice = labels.filter((l, i) => labels.indexOf(l) !== i);
  assert.deepEqual(twice, [], `duplicated: ${twice.join(", ")}`);
});

test("the palette's own query is valid against the schema", () => {
  // Nothing else catches a renamed field here: the document is a string, so it
  // would only fail on a keystroke, in front of a user.
  const errors = validate(
    buildSchema(readFileSync("schema.graphql", "utf8")),
    parse(SEARCH_QUERY),
  );
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});

/* ---- One resource's pages, from the root ------------------------- */

const KNOWN_APPS = [
  { id: "prj_1", slug: "deplo-web", name: "deplo-web", logo: null },
  { id: "prj_2", slug: "gamewatcher", name: "GameWatcher", logo: null },
];
const KNOWN_DBS = [{ id: "db_1", name: "main", type: "postgres", logo: null }];
const OWNED = ownedPageEntries(KNOWN_APPS, KNOWN_DBS);

test("every owned page names its owner and has a unique id", () => {
  assert.ok(OWNED.length > 0);
  assert.ok(
    OWNED.every((e) => e.owner),
    "a page with no owner would render as one of deplo's own",
  );
  const ids = OWNED.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("two words reach one app's page: 'deplo variables'", () => {
  // nav-config calls that page "Environment" and nobody types that, so the
  // match has to read its description too. This is the case that motivated it.
  assert.deepEqual(
    matchOwnedPages(OWNED, "deplo variables").map((e) => [
      e.owner?.name,
      e.label,
      e.run.kind === "href" ? e.run.href : "",
    ]),
    [["deplo-web", "Environment", "/apps/deplo-web/environment"]],
  );
});

test("two words reach a page nav-config spells exactly", () => {
  const hits = matchOwnedPages(OWNED, "gamewatcher domains");
  assert.deepEqual(
    hits.map((e) => [e.owner?.name, e.label]),
    [["GameWatcher", "Domains"]],
  );
  assert.equal(
    hits[0]?.run.kind === "href" ? hits[0].run.href : "",
    "/apps/gamewatcher/domains",
  );
});

test("one word naming a page reaches every app's copy of it", () => {
  assert.deepEqual(
    matchOwnedPages(OWNED, "domains").map((e) => [e.owner?.name, e.label]),
    [
      ["deplo-web", "Domains"],
      ["GameWatcher", "Domains"],
    ],
  );
  assert.deepEqual(
    matchOwnedPages(OWNED, ""),
    [],
    "nothing typed, nothing to show",
  );
});

test("a word that names the app is spent on the app, not on its pages", () => {
  // "deplo" is a prefix of "deployments", so without that rule typing an app's
  // name would bury the app under its own fourteen pages.
  assert.deepEqual(
    matchOwnedPages(OWNED, "deplo").map((e) => e.owner?.name),
    [],
  );
});

test("the cap counts, and the total behind it is knowable", () => {
  assert.equal(countOwnedPages(OWNED, "logs"), 3, "two apps and a database");
  assert.equal(matchOwnedPages(OWNED, "logs", 2).length, 2);
  assert.equal(
    matchOwnedPages(OWNED, "logs", Number.POSITIVE_INFINITY).length,
    countOwnedPages(OWNED, "logs"),
  );
});

test("a resource's own tab outranks the same name inside its settings", () => {
  const hits = matchOwnedPages(OWNED, "deplo deployments");
  assert.deepEqual(
    hits.map((e) => (e.run.kind === "href" ? e.run.href : "")),
    ["/apps/deplo-web/deployments", "/apps/deplo-web/settings/deployments"],
  );
});

test("a word naming neither the owner nor the page rules the row out", () => {
  assert.deepEqual(matchOwnedPages(OWNED, "deplo domains xyzzy"), []);
});

test("databases answer the same way", () => {
  const hits = matchOwnedPages(OWNED, "main backups");
  assert.deepEqual(
    hits.map((e) => [e.owner?.kind, e.owner?.name, e.label]),
    [["database", "main", "Backups"]],
  );
});

test("the list is capped, so one common word cannot flood the palette", () => {
  const many = ownedPageEntries(
    Array.from({ length: 40 }, (_, i) => ({
      id: `prj_${i}`,
      slug: `app-${i}`,
      name: `app-${i}`,
      logo: null,
    })),
    [],
  );
  assert.equal(matchOwnedPages(many, "app logs", 8).length, 8);
});

test("an app is named by its slug too, as it is on the server", () => {
  const owned = ownedPageEntries(
    [{ id: "prj_9", slug: "acme-api-prod", name: "API", logo: null }],
    [],
  );
  assert.deepEqual(
    matchOwnedPages(owned, "acme logs").map((e) => e.label),
    ["Logs"],
  );
});

test("only a resource's own verbs are coloured, and never red", () => {
  const app = appFrameEntries({
    id: "prj_1",
    slug: "blog",
    name: "Blog",
    productionUrl: "https://blog.example.com",
  });
  const toned = new Map(
    app.filter((e) => e.tone).map((e) => [e.label, e.tone]),
  );
  assert.deepEqual(Object.fromEntries(toned), {
    Redeploy: "info",
    Start: "success",
    Stop: "warning",
    Reload: "violet",
  });

  // Navigation, and the two verbs that touch nothing, stay muted.
  for (const label of ["Overview", "Logs", "Copy URL", "Open in a new tab"]) {
    assert.equal(
      app.find((e) => e.label === label)?.tone,
      undefined,
      `"${label}" is not a control`,
    );
  }
  // And so does every row outside a resource's own menu.
  assert.deepEqual(
    staticEntries().filter((e) => e.tone),
    [],
  );
});

test("a row is findable by what its capability is called", () => {
  // "manage" is nowhere on the MCP row - it lives only in `manage_mcp`, whose
  // catalogue entry is called "Manage MCP access" and lists the agents by name.
  const all = staticEntries();
  const label = (q: string) => matchEntries(all, q).map((e) => e.label);

  assert.deepEqual(label("manage mcp"), ["MCP Server"]);
  assert.deepEqual(label("claude"), ["MCP Server"], "a curated keyword");
  assert.deepEqual(label("secrets"), ["Variables"]);
  assert.deepEqual(label("discord"), ["Notifications"]);

  // The same corpus reaches one app's pages, where nav-config gates them.
  const owned = ownedPageEntries(
    [{ id: "p1", slug: "blog", name: "blog", logo: null }],
    [],
  );
  assert.deepEqual(
    matchOwnedPages(owned, "blog basic auth").map((e) => e.label),
    ["Access"],
  );
});

/* ---- The rules that keep one odd name from breaking the rest ---- */

test("two apps may share a display name - the same app in two environments", () => {
  const owned = ownedPageEntries(
    [
      { id: "p1", slug: "api-prod", name: "API", logo: null },
      { id: "p2", slug: "api-staging", name: "API", logo: null },
    ],
    [],
  );
  const which = (q: string) =>
    matchOwnedPages(owned, q).map((e) =>
      e.run.kind === "href" ? e.run.href : "",
    );

  assert.deepEqual(which("staging logs"), ["/apps/api-staging/logs"]);
  assert.deepEqual(which("prod logs"), ["/apps/api-prod/logs"]);
  assert.deepEqual(which("api logs").sort(), [
    "/apps/api-prod/logs",
    "/apps/api-staging/logs",
  ]);
});

test("an app called after a page does not take that word away from everyone", () => {
  // Someone WILL name an app "logs". Before, that made `logs` unable to reach
  // any app's Logs page at all, for the whole team.
  const owned = ownedPageEntries(
    [
      { id: "p1", slug: "logs", name: "logs", logo: null },
      { id: "p2", slug: "blog", name: "blog", logo: null },
    ],
    [],
  );
  assert.deepEqual(
    matchOwnedPages(owned, "logs").map((e) => e.owner?.name),
    ["logs", "blog"],
  );
});

test("an accent is not a different letter", () => {
  const owned = ownedPageEntries(
    [{ id: "p1", slug: "muc", name: "Café Münchén", logo: null }],
    [],
  );
  for (const q of ["cafe logs", "café logs", "munchen logs", "münchén logs"]) {
    assert.equal(matchOwnedPages(owned, q).length, 1, q);
  }
});

test("a word that only PREFIXES a page name still names the app", () => {
  // "deplo" is a prefix of "deployments"; the app is what was meant.
  const owned = ownedPageEntries(
    [
      { id: "p1", slug: "deplo-web", name: "deplo-web", logo: null },
      { id: "p2", slug: "blog", name: "blog", logo: null },
    ],
    [],
  );
  assert.deepEqual(matchOwnedPages(owned, "deplo"), []);
  assert.equal(
    matchOwnedPages(owned, "deployments").length,
    4,
    "both apps, both tabs",
  );
});

test("every gate names a capability that exists", () => {
  // A typo here is invisible twice over: `canSee` hides the row for everyone,
  // and the capability's own words never join what the row can be found by.
  const rows = [
    ...staticEntries(),
    ...appFrameEntries(APP),
    ...dbFrameEntries({ id: "db_1", name: "Main", type: "postgres" }),
    ...teamPageEntries([{ id: "t2", name: "Acme" }], "t1"),
  ];
  const known = new Set<string>(ALL_CAPABILITIES);
  for (const row of rows) {
    for (const cap of [row.requires, ...(row.requiresAny ?? [])]) {
      if (!cap) continue;
      assert.ok(known.has(cap), `"${row.label}" is gated on "${cap}"`);
    }
  }
});

test("a capability's words reach the row it gates, wherever the row is", () => {
  const inTeam = teamPageEntries([{ id: "t2", name: "Acme" }], "t1");
  assert.deepEqual(
    matchEntries(inTeam, "manage mcp").map((e) => e.label),
    ["MCP Server"],
    "and not only in the active team's copy",
  );
});

test("a database frame stays inside that database", () => {
  const db = { id: "db_1", name: "Main", type: "postgres" as const };
  const entries = dbFrameEntries(db);
  const labels = entries.map((e) => e.label);

  assert.deepEqual(
    entries.filter((e) => e.group === "Actions").map((e) => e.label),
    ["Redeploy", "Restart"],
    "the two verbs a database has - there is no Start/Stop for one",
  );
  for (const want of [
    "Overview",
    "Logs",
    "Backups",
    "Settings",
    "Connection",
  ]) {
    assert.ok(labels.includes(want), `missing "${want}"`);
  }
  for (const entry of entries) {
    if (entry.run.kind !== "href") continue;
    assert.ok(
      entry.run.href.startsWith("/storage/databases/db_1"),
      `${entry.label} leaves the database: ${entry.run.href}`,
    );
  }
  // Its Overview and its settings root are one page, listed once.
  const hrefs = entries.flatMap((e) =>
    e.run.kind === "href" ? [e.run.href] : [],
  );
  assert.equal(new Set(hrefs).size, hrefs.length, "no destination twice");
});

test("a database's switched-off tabs are not offered either", () => {
  const off = dbFrameEntries({ id: "db_1", name: "Main", type: "postgres" });
  assert.ok(!off.map((e) => e.label).includes("Cron jobs"));

  const on = dbFrameEntries(
    { id: "db_1", name: "Main", type: "postgres" },
    { ...PALETTE_DB_FLAGS, cronsEnabled: true },
  );
  assert.ok(on.map((e) => e.label).includes("Cron jobs"));
});

test("folding never invents a word across two real ones", () => {
  // "access login" folded to one string reads "...accesSSLogin...", so the
  // Access page answered to "ssl". Certificates live on Domains, not there.
  const frame = appFrameEntries(APP);
  assert.deepEqual(
    matchEntries(frame, "ssl").map((e) => e.label),
    ["Domains"],
    "and not Access, which only spelled it across a word boundary",
  );

  // ...and the hyphen inside ONE word still folds away, which is the whole
  // reason the rule ignores separators.
  const rows = [
    {
      id: "x",
      label: "better-auth-docs",
      icon: APP_ACTIONS[0]!.icon,
      group: "Apps",
      run: { kind: "href" as const, href: "/x" },
    },
  ];
  assert.equal(matchEntries(rows, "better auth").length, 1);
  assert.equal(matchEntries(rows, "betterauth").length, 1);
  assert.equal(matchEntries(rows, "authdocs").length, 1);
});

test("the words people type reach the page that answers them", () => {
  // Each of these reached nothing while its page sat right there.
  const stat = staticEntries();
  const expected: [string, string][] = [
    ["2fa", "Security"],
    ["totp", "Security"],
    ["smtp", "Notifications"],
    ["registry", "Registries"],
    ["dockerhub", "Registries"],
    ["permissions", "Roles"],
    ["apikey", "API tokens"],
    ["migrate", "Migrations"],
    ["rollback", "Deployments"],
    ["cleanup", "Servers"],
  ];
  for (const [typed, page] of expected) {
    assert.ok(
      matchEntries(stat, typed).some((e) => e.label === page),
      `"${typed}" should reach ${page}`,
    );
  }

  // And the per-app tabs, which carry the slug in their href.
  const tabs = appFrameEntries(APP);
  for (const typed of ["ssl", "https", "certificate"]) {
    assert.deepEqual(
      matchEntries(tabs, typed).map((e) => e.label),
      ["Domains"],
      typed,
    );
  }
});
