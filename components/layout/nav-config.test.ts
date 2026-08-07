import { test } from "node:test";
import assert from "node:assert/strict";

import { appNav, appSettingsNav, type AppNavFlags } from "./nav-config";

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
