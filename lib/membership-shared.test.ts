import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_PRESETS,
  capabilitiesForRole,
  cleanCapabilities,
  roleLabelForCapabilities,
} from "./membership-shared";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_META,
  LEGACY_CAPABILITY_EXPANSION,
  RETIRED_CAPABILITY_NAMES,
  expandLegacyCapabilities,
  searchCapabilities,
} from "./capabilities";
import { ALL_CAPABILITIES } from "./types";

test("owner preset grants every capability", () => {
  assert.equal(CAPABILITY_PRESETS.owner.length, ALL_CAPABILITIES.length);
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(CAPABILITY_PRESETS.owner.includes(cap), `owner missing ${cap}`);
  }
});

test("viewer preset is read-only - it can look at everything, change nothing", () => {
  assert.deepEqual(CAPABILITY_PRESETS.viewer, [
    "view",
    "view_logs",
    "view_metrics",
    "view_activity",
  ]);
});

test("member ships apps and their config, but touches no infrastructure or admin", () => {
  const m = CAPABILITY_PRESETS.member;
  for (const cap of [
    "create_apps",
    "deploy_apps",
    "control_apps",
    "configure_apps",
    "delete_apps",
    "manage_domains",
    "manage_env",
    "read_app_files",
    "write_app_files",
    "create_projects",
    "manage_environments",
  ] as const) {
    assert.ok(m.includes(cap), `member missing ${cap}`);
  }
  for (const cap of [
    "manage_team",
    "delete_team",
    "manage_members",
    "manage_roles",
    "create_databases",
    "delete_databases",
    "manage_backups",
    "manage_backup_destinations",
    "manage_tokens",
  ] as const) {
    assert.ok(!m.includes(cap), `member should not hold ${cap}`);
  }
});

test("capabilitiesForRole returns a fresh copy (not the preset reference)", () => {
  const caps = capabilitiesForRole("member");
  caps.push("manage_team");
  assert.ok(!CAPABILITY_PRESETS.member.includes("manage_team"));
});

test("roleLabelForCapabilities recognizes exact presets, else 'custom'", () => {
  assert.equal(roleLabelForCapabilities(capabilitiesForRole("owner")), "owner");
  assert.equal(
    roleLabelForCapabilities(capabilitiesForRole("viewer")),
    "viewer",
  );
  assert.equal(
    roleLabelForCapabilities(capabilitiesForRole("member")),
    "member",
  );
  assert.equal(roleLabelForCapabilities(["view", "deploy_apps"]), "custom");
});

/* ------------------------------------------------------------------ */
/* The catalog                                                         */
/* ------------------------------------------------------------------ */

test("every capability is described exactly once, in exactly one category", () => {
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(CAPABILITY_META[cap], `no meta for ${cap}`);
    assert.ok(CAPABILITY_META[cap].label.length > 0);
    assert.ok(CAPABILITY_META[cap].description.length > 0);
  }
  const categorised = CAPABILITY_CATEGORIES.flatMap((c) => c.caps);
  assert.equal(
    new Set(categorised).size,
    categorised.length,
    "a capability appears in two categories",
  );
  // `view` is the always-on floor and is deliberately in no category.
  assert.deepEqual(
    ALL_CAPABILITIES.filter((c) => c !== "view" && !categorised.includes(c)),
    [],
    "some capability is in no category, so the role editor can't show it",
  );
  assert.deepEqual(
    categorised.filter((c) => !ALL_CAPABILITIES.includes(c)),
    [],
  );
});

test("the legacy split preserves access: the old eight expand, nothing is orphaned", () => {
  // Every expansion target is a real capability…
  for (const [old, caps] of Object.entries(LEGACY_CAPABILITY_EXPANSION)) {
    for (const c of caps) {
      assert.ok(ALL_CAPABILITIES.includes(c), `${old} expands to unknown ${c}`);
    }
  }
  // …and between them the eight cover the whole catalog, so no member could come
  // out of the migration missing something they used to have.
  const covered = new Set(Object.values(LEGACY_CAPABILITY_EXPANSION).flat());
  assert.deepEqual(
    ALL_CAPABILITIES.filter((c) => !covered.has(c)),
    [],
    "a capability no old name expands to - the migration would under-grant it",
  );
  // The retired names are the only ones that still expand as input: the three the
  // split dropped, plus `manage_s3`, which was RENAMED to
  // `manage_backup_destinations` when a destination stopped necessarily being a
  assert.deepEqual(RETIRED_CAPABILITY_NAMES.sort(), [
    "deploy",
    "manage_files",
    "manage_infra",
    "manage_s3",
  ]);
});

test("expandLegacyCapabilities expands only the RETIRED names", () => {
  const once = expandLegacyCapabilities(["view", "deploy"]);
  assert.deepEqual(expandLegacyCapabilities(once), once, "idempotent");
  assert.deepEqual(expandLegacyCapabilities(["nonsense"]), []);
  assert.deepEqual(expandLegacyCapabilities(["delete_apps"]), ["delete_apps"]);
  // A name that is STILL a capability means exactly itself. The role editor
  // sends `view` on every save, and `manage_env` whenever it is ticked: quietly
  // turning those into more permissions would grant what nobody chose.
  assert.deepEqual(expandLegacyCapabilities(["view"]), ["view"]);
  assert.deepEqual(expandLegacyCapabilities(["manage_env"]), ["manage_env"]);
  assert.deepEqual(expandLegacyCapabilities(["manage_members"]), [
    "manage_members",
  ]);
  // …while the three that no longer exist do expand.
  assert.ok(
    expandLegacyCapabilities(["manage_files"]).includes("write_app_files"),
  );
  assert.ok(
    expandLegacyCapabilities(["manage_infra"]).includes(
      "manage_backup_destinations",
    ),
  );
});

test("cleanCapabilities accepts an old-world list from an API client", () => {
  // A saved script still sending `deploy` keeps meaning what it meant.
  const caps = cleanCapabilities(["deploy"] as never, "member");
  assert.ok(caps.includes("create_apps"));
  assert.ok(caps.includes("delete_apps"));
  assert.ok(caps.includes("view"), "view is always the floor");
  assert.ok(!caps.includes("manage_env"), "deploy never meant env vars");
});

test("search finds a permission by what it does, not only by its name", () => {
  assert.ok(searchCapabilities("ssh").includes("open_app_console"));
  assert.ok(searchCapabilities("api").includes("manage_tokens"));
  assert.ok(searchCapabilities("delete database").includes("delete_databases"));
  assert.ok(
    searchCapabilities("bucket").includes("manage_backup_destinations"),
  );
  // Multi-term search is AND, and an empty query is everything.
  assert.deepEqual(searchCapabilities(""), ALL_CAPABILITIES);
  assert.deepEqual(searchCapabilities("zzzznope"), []);
});
