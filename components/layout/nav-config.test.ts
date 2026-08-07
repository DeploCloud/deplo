import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appNav,
  appSettingsNav,
  databaseNav,
  databaseSettingsNav,
  type AppNavFlags,
} from "./nav-config";

/**
 * Who gets offered what in an app's sub-menu.
 *
 * The Pull requests rule in particular has moved twice under discussion, and
 * nothing was pinning it: three conditions decide the operational entry and one
 * decides the settings entry, and getting any of them backwards means either a
 * dead end or a feature nobody can find. Pure functions, so this is cheap.
 */

const FLAGS: AppNavFlags = {
  pathname: "/apps/blog",
  canManageEnv: true,
  canBackup: true,
  running: true,
  showFiles: true,
  isGithubApp: true,
  previewsEnabled: true,
  cronsEnabled: true,
  consoleAcknowledged: true,
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
  // so the page cannot even be where you go to find leftovers — and the setting
  // that turns it back on lives under Settings, which is always reachable.
  assert.ok(!labels(flags({ previewsEnabled: false })).includes("Pull requests"));

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
  // Otherwise turning previews off from the settings page — or landing here by
  // URL — would make the entry vanish from under the page being read.
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

const cronItem = () =>
  appSettingsNav("blog")
    .flatMap((s) => s.items)
    .find((i) => i.label === "Cron jobs");

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

test("the Cron jobs entries are gated on manage_crons", () => {
  const operational = appNav("blog", flags())
    .flatMap((s) => s.items)
    .find((i) => i.label === "Cron jobs");
  assert.equal(operational?.requires, "manage_crons");
  assert.equal(cronItem()?.requires, "manage_crons");
});

test("the Cron jobs settings entry is always live", () => {
  // No `disabledReason` twin: unlike previews, nothing makes an app incapable.
  assert.ok(cronItem());
  assert.equal(cronItem()?.disabledReason, undefined);
});

test("a database gets Cron jobs on the same rule", () => {
  const dbLabels = (cronsEnabled: boolean, pathname = "/storage/databases/db_1") =>
    databaseNav("db_1", { pathname, consoleAcknowledged: false, cronsEnabled })
      .flatMap((s) => s.items)
      .map((i) => i.label);

  assert.ok(dbLabels(true).includes("Cron jobs"));
  assert.ok(!dbLabels(false).includes("Cron jobs"));
  // And it survives while open, like the app's.
  assert.ok(dbLabels(false, "/storage/databases/db_1/cron-jobs").includes("Cron jobs"));
  // The settings entry is unconditional there too.
  assert.ok(
    databaseSettingsNav("db_1")
      .flatMap((s) => s.items)
      .some((i) => i.label === "Cron jobs"),
  );
});
