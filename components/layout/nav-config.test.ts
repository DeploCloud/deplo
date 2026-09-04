import { test } from "node:test";
import assert from "node:assert/strict";

import { DeploMark } from "@/components/logo";

import {
  appNav,
  appSettingsNav,
  databaseNav,
  databaseSettingsNav,
  SETTINGS_NAV,
  type AppNavFlags,
  isNonTeamSettings,
  sidebarMenuFor,
} from "./nav-config";

/**
 * Who gets offered what in an app's sub-menu.
 */

const FLAGS: AppNavFlags = {
  pathname: "/apps/blog",
  canManageEnv: true,
  canBackup: true,
  running: true,
  isGithubApp: true,
  previewsEnabled: true,
  cronsEnabled: true,
  consoleEnabled: true,
};

const flags = (over: Partial<AppNavFlags> = {}): AppNavFlags => ({
  ...FLAGS,
  ...over,
});

const labels = (f: AppNavFlags) =>
  appNav("blog", f).flatMap((s) => s.items.map((i) => i.label));

const settingsItem = (isGithubApp: boolean) =>
  appSettingsNav("blog", isGithubApp)
    .flatMap((s) => s.items)
    .find((i) => i.label === "Pull requests");

test("the app menu offers Pull requests only when previews are actually on", () => {
  assert.ok(labels(flags()).includes("Pull requests"));

  // Off ⇒ nothing to list. Turning the switch off destroys every live preview,
  // so the page cannot even be where you go to find leftovers, and the setting
  // that turns it back on lives under Settings, which is always reachable.
  assert.ok(
    !labels(flags({ previewsEnabled: false })).includes("Pull requests"),
  );

  // Not a GitHub app ⇒ never, at any setting. Nothing else receives a
  // `pull_request` delivery, so the page could only ever be a dead end.
  assert.ok(!labels(flags({ isGithubApp: false })).includes("Pull requests"));
  assert.ok(
    !labels(flags({ isGithubApp: false, previewsEnabled: true })).includes(
      "Pull requests",
    ),
  );
});

test("the entry survives while you are standing on the page", () => {
  // Otherwise turning previews off from the settings page, or landing here by
  // URL - would make the entry vanish from under the page being read.
  assert.ok(
    labels(
      flags({ previewsEnabled: false, pathname: "/apps/blog/pull-requests" }),
    ).includes("Pull requests"),
  );
});

test("the SETTINGS entry is always there, disabled when the app cannot use it", () => {
  const github = settingsItem(true);
  assert.ok(github, "a GitHub app must reach the settings");
  assert.equal(github!.disabledReason, undefined);
  assert.equal(github!.requires, "manage_previews");

  // Shown, not hidden: a missing row would leave someone hunting for a feature
  // they were told about. The reason rides in the tooltip.
  const other = settingsItem(false);
  assert.ok(other, "a non-GitHub app must still SEE that the feature exists");
  assert.match(other!.disabledReason ?? "", /GitHub/);
});

/* ---- Cron jobs ---------------------------------------------------- */

test("the app menu offers Cron jobs only when they are switched on", () => {
  assert.ok(labels(flags()).includes("Cron jobs"));
  assert.ok(!labels(flags({ cronsEnabled: false })).includes("Cron jobs"));
});

test("Cron jobs does not need a GitHub app, unlike Pull requests", () => {
  // Every app can run a command in its own container, so there is no structural
  // impossibility here - this is what separates the two entries' rules.
  const f = flags({ isGithubApp: false });
  assert.ok(labels(f).includes("Cron jobs"));
  assert.ok(!labels(f).includes("Pull requests"));
});

test("the Cron jobs entry survives while you are standing on it", () => {
  // Turning the switch off from the page itself must not pull the entry out from
  // under the reader.
  const f = flags({ cronsEnabled: false, pathname: "/apps/blog/cron-jobs" });
  assert.ok(labels(f).includes("Cron jobs"));
});

test("the Cron jobs entry is gated on manage_crons", () => {
  const operational = appNav("blog", flags())
    .flatMap((s) => s.items)
    .find((i) => i.label === "Cron jobs");
  assert.equal(operational?.requires, "manage_crons");
});

test("Cron jobs has no settings entry of its own - the switch is under Advanced", () => {
  // It is a row of Settings → Advanced → Advanced features now, next to the
  // Console: an opt-in feature does not get a permanent seat in the settings
  // menu of every app that will never turn it on.
  for (const nav of [appSettingsNav("blog"), databaseSettingsNav("db_1")]) {
    assert.ok(
      !nav.flatMap((s) => s.items).some((i) => i.label === "Cron jobs"),
    );
    assert.ok(nav.flatMap((s) => s.items).some((i) => i.label === "Advanced"));
  }
});

test("Activity sits just before Settings, never in a settings menu", () => {
  // It answers "what happened", not "how is this configured", so it is an
  // operational entry in both main menus - like Logs and Monitoring.
  const menus = [
    appNav("blog", flags()),
    databaseNav("db_1", {
      pathname: "/storage/databases/db_1",
      consoleAcknowledged: false,
      cronsEnabled: false,
    }),
  ];
  for (const nav of menus) {
    const items = nav.flatMap((s) => s.items);
    const activity = items.at(-2);
    assert.equal(activity?.label, "Activity");
    assert.equal(activity?.requires, "view_activity");
    assert.equal(items.at(-1)?.label, "Settings");
  }
  for (const nav of [appSettingsNav("blog"), databaseSettingsNav("db_1")]) {
    assert.ok(!nav.flatMap((s) => s.items).some((i) => i.label === "Activity"));
  }
});

test("a database gets Cron jobs on the same rule", () => {
  const dbLabels = (
    cronsEnabled: boolean,
    pathname = "/storage/databases/db_1",
  ) =>
    databaseNav("db_1", { pathname, consoleAcknowledged: false, cronsEnabled })
      .flatMap((s) => s.items)
      .map((i) => i.label);

  assert.ok(dbLabels(true).includes("Cron jobs"));
  assert.ok(!dbLabels(false).includes("Cron jobs"));
  // And it survives while open, like the app's.
  assert.ok(
    dbLabels(false, "/storage/databases/db_1/cron-jobs").includes("Cron jobs"),
  );
});

test("MCP Server is offered to either capability that opens half of it", () => {
  // Two different people have work to do there: `manage_mcp` connects their own
  // agent, `manage_team` owns the team's switch.
  const mcp = SETTINGS_NAV.flatMap((s) => s.items).find(
    (i) => i.href === "/settings/mcp",
  );
  assert.ok(mcp, "the MCP Server entry disappeared");
  assert.equal(
    mcp.requires,
    undefined,
    "a single `requires` locks one of them out",
  );
  assert.deepEqual(mcp.requiresAny?.slice().sort(), [
    "manage_mcp",
    "manage_team",
  ]);
});

test("the Console chip follows the app's own switch, not just a running container", () => {
  assert.ok(labels(flags()).includes("Console"));
  // Off in Advanced settings ⇒ the route 404s, so the chip must not offer it.
  assert.ok(!labels(flags({ consoleEnabled: false })).includes("Console"));
  // On but stopped: nothing to attach to until it runs again.
  assert.ok(!labels(flags({ running: false })).includes("Console"));
});

test("the sidebar swaps to a sub-menu only where there is one", () => {
  const at = (p: string) => sidebarMenuFor(p).menu;
  // The workspace itself, and every page that is still the workspace.
  assert.equal(at("/"), "main");
  assert.equal(at("/deployments"), "main");
  assert.equal(at("/storage"), "main");
  // A drill-in, and the level below it.
  assert.equal(at("/apps/shop"), "service");
  assert.equal(at("/apps/shop/logs"), "service");
  assert.equal(at("/apps/shop/settings"), "service-settings");
  assert.equal(at("/apps/shop/settings/deployments"), "service-settings");
  assert.equal(at("/storage/databases/db_1"), "service");
  assert.equal(at("/storage/databases/db_1/settings"), "service-settings");
  assert.equal(at("/settings"), "settings");
  assert.equal(at("/settings/servers"), "settings");
  // A path that merely STARTS like one is not one: the segment has to end.
  assert.equal(at("/apps/shop/settings-preview"), "service");
  assert.equal(sidebarMenuFor("/apps/shop/settings").appSlug, "shop");
  assert.equal(sidebarMenuFor("/storage/databases/db_1").dbId, "db_1");
  assert.equal(sidebarMenuFor("/").appSlug, null);
});

test("System opens on Deplo, wearing the mark", () => {
  const system = SETTINGS_NAV.find((s) => s.title === "System");
  assert.ok(system, "the System group disappeared");
  // First, because it is the instance the other two entries live in - and the
  // mark, because SlidersHorizontal is the Advanced glyph everywhere else.
  assert.equal(system.items[0]?.href, "/settings/deplo");
  assert.equal(system.items[0]?.icon, DeploMark);
  assert.equal(system.items[1]?.href, "/settings/migrations");
  assert.equal(system.items[2]?.href, "/settings/servers");
});

// A migration lands each source team in a team of the operator's choosing, so
// it is the instance's page, not one team's: under System, admins only, and
// without a team switcher that would suggest the page's team matters.
test("Migrations is an instance page", () => {
  const team = SETTINGS_NAV.find((s) => s.title === "Team");
  assert.ok(!team?.items.some((i) => i.href === "/settings/migrations"));
  const system = SETTINGS_NAV.find((s) => s.title === "System");
  const migrations = system?.items.find(
    (i) => i.href === "/settings/migrations",
  );
  assert.equal(migrations?.requiresAdmin, true);
  assert.equal(migrations?.requires, undefined);
  assert.equal(isNonTeamSettings("/settings/migrations"), true);
});
