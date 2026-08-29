import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSchema, parse, validate } from "graphql";

import { NAV, SETTINGS_NAV, canSee } from "@/components/layout/nav-config";
import { ALL_CAPABILITIES } from "@/lib/types";
import { SEARCH_QUERY } from "./search-query";
import {
  APP_ACTIONS,
  DB_ACTIONS,
  PALETTE_APP_FLAGS,
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
