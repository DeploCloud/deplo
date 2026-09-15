import { test } from "node:test";
import assert from "node:assert/strict";

import { DeploMark } from "@/components/logo";

import { isNonTeamSettings, sidebarMenuFor } from "./nav-config/active-route";
import { appNav, appSettingsNav, type AppNavFlags } from "./nav-config/app-nav";
import { databaseNav, databaseSettingsNav } from "./nav-config/database-nav";
import { SETTINGS_NAV } from "./nav-config/settings-nav";

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

  assert.ok(
    !labels(flags({ previewsEnabled: false })).includes("Pull requests"),
  );

  assert.ok(!labels(flags({ isGithubApp: false })).includes("Pull requests"));
  assert.ok(
    !labels(flags({ isGithubApp: false, previewsEnabled: true })).includes(
      "Pull requests",
    ),
  );
});

test("the entry survives while you are standing on the page", () => {
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

  const other = settingsItem(false);
  assert.ok(other, "a non-GitHub app must still SEE that the feature exists");
  assert.match(other!.disabledReason ?? "", /GitHub/);
});

test("the app menu offers Cron jobs only when they are switched on", () => {
  assert.ok(labels(flags()).includes("Cron jobs"));
  assert.ok(!labels(flags({ cronsEnabled: false })).includes("Cron jobs"));
});

test("Cron jobs does not need a GitHub app, unlike Pull requests", () => {
  const f = flags({ isGithubApp: false });
  assert.ok(labels(f).includes("Cron jobs"));
  assert.ok(!labels(f).includes("Pull requests"));
});

test("the Cron jobs entry survives while you are standing on it", () => {
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
  for (const nav of [appSettingsNav("blog"), databaseSettingsNav("db_1")]) {
    assert.ok(
      !nav.flatMap((s) => s.items).some((i) => i.label === "Cron jobs"),
    );
    assert.ok(nav.flatMap((s) => s.items).some((i) => i.label === "Advanced"));
  }
});

test("Activity sits just before Settings, never in a settings menu", () => {
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
  assert.ok(
    dbLabels(false, "/storage/databases/db_1/cron-jobs").includes("Cron jobs"),
  );
});

test("MCP Server is offered to either capability that opens half of it", () => {
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
  assert.ok(!labels(flags({ consoleEnabled: false })).includes("Console"));
  assert.ok(!labels(flags({ running: false })).includes("Console"));
});

test("the sidebar swaps to a sub-menu only where there is one", () => {
  const at = (p: string) => sidebarMenuFor(p).menu;
  assert.equal(at("/"), "main");
  assert.equal(at("/deployments"), "main");
  assert.equal(at("/storage"), "main");
  assert.equal(at("/apps/shop"), "service");
  assert.equal(at("/apps/shop/logs"), "service");
  assert.equal(at("/apps/shop/settings"), "service-settings");
  assert.equal(at("/apps/shop/settings/deployments"), "service-settings");
  assert.equal(at("/storage/databases/db_1"), "service");
  assert.equal(at("/storage/databases/db_1/settings"), "service-settings");
  assert.equal(at("/settings"), "settings");
  assert.equal(at("/settings/servers"), "settings");
  assert.equal(at("/apps/shop/settings-preview"), "service");
  assert.equal(sidebarMenuFor("/apps/shop/settings").appSlug, "shop");
  assert.equal(sidebarMenuFor("/storage/databases/db_1").dbId, "db_1");
  assert.equal(sidebarMenuFor("/").appSlug, null);
});

test("System opens on Deplo, wearing the mark", () => {
  const system = SETTINGS_NAV.find((s) => s.title === "System");
  assert.ok(system, "the System group disappeared");
  assert.equal(system.items[0]?.href, "/settings/deplo");
  assert.equal(system.items[0]?.icon, DeploMark);
  assert.equal(system.items[1]?.href, "/settings/migrations");
  assert.equal(system.items[2]?.href, "/settings/servers");
});

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
