import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appTypeLabel,
  cn,
  formatBuildDuration,
  formatClockTime,
  formatDateTime,
  gitProfileUrl,
  isHexColor,
  normalizeHexColor,
  pickerInstallationId,
  readableTextColor,
  repoCredentialMissing,
  safeReturnPath,
  timeAgoShort,
} from "./utils";
import { FOLDER_COLORS } from "./folder-colors";

test("isHexColor accepts 3/6-digit hex (with or without #, any case), rejects junk", () => {
  for (const ok of ["#fff", "fff", "#3b82f6", "3B82F6", "  #abc  "]) {
    assert.equal(isHexColor(ok), true, `expected ${ok} to be valid`);
  }
  for (const bad of ["", "#ff", "#fffff", "#1234567", "#gggggg", "blue"]) {
    assert.equal(isHexColor(bad), false, `expected ${bad} to be invalid`);
  }
});

test("normalizeHexColor canonicalises to lowercase #rrggbb and expands shorthand", () => {
  assert.equal(normalizeHexColor("#FFF"), "#ffffff");
  assert.equal(normalizeHexColor("abc"), "#aabbcc");
  assert.equal(normalizeHexColor("  #3B82F6 "), "#3b82f6");
  assert.throws(() => normalizeHexColor("#12"), /valid hex/);
  assert.throws(() => normalizeHexColor("nope"), /valid hex/);
});

test("readableTextColor picks the higher-contrast foreground (auto-contrast)", () => {
  assert.equal(readableTextColor("#ffffff"), "#000000");
  assert.equal(readableTextColor("#000000"), "#ffffff");
  assert.equal(readableTextColor("#facc15"), "#000000");
  assert.equal(readableTextColor("#f59e0b"), "#000000");
  assert.equal(readableTextColor("#1e1b4b"), "#ffffff");
  assert.equal(readableTextColor("fff"), "#000000");
  assert.equal(readableTextColor("#000"), "#ffffff");
  assert.equal(readableTextColor("nope"), "#000000");
});

test("appTypeLabel names the App kind, tracking usesComposeStack", () => {
  const base = {
    source: "github",
    compose: null,
    repo: null,
    dockerImage: null,
  };
  assert.equal(appTypeLabel(base), "Application");
  assert.equal(appTypeLabel({ ...base, source: "git" }), "Application");
  assert.equal(
    appTypeLabel({ ...base, source: "docker-image", dockerImage: "nginx" }),
    "Application",
  );
  assert.equal(
    appTypeLabel({ ...base, source: "upload", compose: "services: {}" }),
    "Application",
  );
  assert.equal(appTypeLabel({ ...base, source: "compose" }), "Compose app");
  assert.equal(
    appTypeLabel({ ...base, source: "git", compose: "services: {}" }),
    "Compose app",
  );
});

test("formatBuildDuration rounds DOWN so a live timer never over-reports", () => {
  assert.equal(formatBuildDuration(1_999), "1s");
  assert.equal(formatBuildDuration(45_000), "45s");
  assert.equal(formatBuildDuration(59_999), "59s");
  assert.equal(formatBuildDuration(60_000), "1m 0s");
  assert.equal(formatBuildDuration(125_000), "2m 5s");
});

test("formatBuildDuration: a sub-second build reports milliseconds, not 0s", () => {
  assert.equal(formatBuildDuration(400), "400ms");
  assert.equal(formatBuildDuration(7), "7ms");
  assert.equal(formatBuildDuration(999), "999ms");
  assert.equal(formatBuildDuration(12.9), "12ms");
  assert.equal(formatBuildDuration(999.9), "999ms");
  assert.equal(formatBuildDuration(1_000), "1s");
});

test("formatBuildDuration: no duration renders empty, a negative one clamps to 0ms", () => {
  assert.equal(formatBuildDuration(null), "");
  assert.equal(formatBuildDuration(-5_000), "0ms");
});

test("readableTextColor returns a valid foreground for every curated folder colour", () => {
  for (const c of FOLDER_COLORS) {
    const fg = readableTextColor(c.value);
    assert.ok(
      fg === "#000000" || fg === "#ffffff",
      `${c.name} (${c.value}) → ${fg}`,
    );
  }
});

test("cn keeps a breakpoint-scoped size when a call site overrides the base one", () => {
  const merged = cn(
    "text-base leading-none font-semibold tracking-tight lg:text-lg",
    "flex w-fit items-center gap-2 text-base",
  );
  assert.match(merged, /\blg:text-lg\b/);
  assert.match(merged, /\btext-base\b/);

  const pinned = cn(
    "text-base font-semibold lg:text-lg",
    "text-2xl lg:text-2xl",
  );
  assert.doesNotMatch(pinned, /\blg:text-lg\b/);
  assert.doesNotMatch(pinned, /(^|\s)text-base(\s|$)/);
});

test("pickerInstallationId never invents a GitHub App for an app that already has a repo", () => {
  const insts = [{ id: "gi_first" }, { id: "gi_real" }];
  assert.equal(pickerInstallationId(undefined, insts), "gi_first");
  assert.equal(
    pickerInstallationId({ installationId: "gi_real" }, insts),
    "gi_real",
  );
  // An imported app: repo set, credential NULL. Answering "gi_first" here is how the UI
  // came to claim a connection the database never had.
  assert.equal(pickerInstallationId({ installationId: null }, insts), "");
  // A re-installed App re-keys the row: the stored id is gone. Same lie, same answer.
  assert.equal(pickerInstallationId({ installationId: "gi_gone" }, insts), "");
  assert.equal(pickerInstallationId(undefined, []), "");
});

test("only a row that claims a GitHub App it lacks is flagged", () => {
  const bare = { installationId: null, connectionId: null };
  assert.equal(repoCredentialMissing({ source: "github", repo: bare }), true);
  assert.equal(
    repoCredentialMissing({
      source: "github",
      repo: { installationId: "gi_1" },
    }),
    false,
  );
  assert.equal(
    repoCredentialMissing({ source: "github", repo: { connectionId: "gc_1" } }),
    false,
  );
  // A bare Repository URL is the documented use of that source: an anonymous clone of a
  // PUBLIC repo deploys fine, so widening this to "no credential" warns on a healthy app.
  assert.equal(repoCredentialMissing({ source: "git", repo: bare }), false);
  assert.equal(
    repoCredentialMissing({ source: "docker-image", repo: null }),
    false,
  );
  assert.equal(repoCredentialMissing({ source: "github", repo: null }), false);
});

test("safeReturnPath keeps in-app paths and refuses anything that leaves the app", () => {
  for (const ok of [
    "/new",
    "/new?template=ghost&variant=sqlite",
    "/apps/blog/settings/deployments",
    "  /new  ",
  ]) {
    assert.equal(safeReturnPath(ok), ok.trim(), `expected ${ok} to be kept`);
  }
  for (const bad of [
    "",
    "   ",
    null,
    undefined,
    "new",
    "https://evil.example.com",
    "//evil.example.com",
    "/\\evil.example.com",
    "javascript:alert(1)",
    // An API route is never a page to land on, and the GitHub ones would re-enter the
    // flow that issued the address.
    "/api/github/setup",
  ]) {
    assert.equal(safeReturnPath(bad), null, `expected ${bad} to be refused`);
  }
});

test("timeAgoShort compresses the unit and keeps the suffix", () => {
  const h = new Date(Date.now() - 8 * 60 * 60 * 1000);
  assert.equal(timeAgoShort(h), "8h ago");
  assert.equal(
    timeAgoShort(new Date(Date.now() - 26 * 60 * 60 * 1000)),
    "1d ago",
  );
  assert.equal(timeAgoShort(new Date(Date.now() + 3 * 60 * 1000)), "in 3m");
  assert.equal(timeAgoShort("not a date"), "");
});

test("formatClockTime pads UTC and only shows millis when asked", () => {
  const ts = "2026-08-27T19:39:04.007Z";
  assert.equal(formatClockTime(ts), "19:39:04");
  assert.equal(formatClockTime(ts, true), "19:39:04.007");
  assert.equal(
    formatClockTime("2026-01-02T00:00:00.000Z", true),
    "00:00:00.000",
  );
  assert.equal(formatClockTime("not a date"), "");
});

test("formatDateTime pairs a date with a clock, and refuses junk", () => {
  assert.match(
    formatDateTime("2026-08-22T03:00:00Z"),
    /^\d{1,2} \w{3}, \d{2}:\d{2}$/,
  );
  assert.equal(formatDateTime("not a date"), "");
});

test("gitProfileUrl links a pusher's account, and only when it can", () => {
  assert.equal(
    gitProfileUrl("github", "idradev"),
    "https://github.com/idradev",
  );
  assert.equal(
    gitProfileUrl("bitbucket", "@idradev"),
    "https://bitbucket.org/idradev",
  );
  assert.equal(
    gitProfileUrl("gitea", "idradev", "https://git.acme.com/team/api.git"),
    "https://git.acme.com/idradev",
  );
  assert.equal(gitProfileUrl("gitea", "idradev"), null);
  assert.equal(gitProfileUrl(null, "Owner"), null);
  assert.equal(gitProfileUrl("svn", "idradev"), null);
  assert.equal(gitProfileUrl("bitbucket", "Ada Lovelace"), null);
  assert.equal(gitProfileUrl("github", "github"), null);
  assert.equal(
    gitProfileUrl("gitea", "Gitea", "https://git.acme.com/t/a"),
    null,
  );
  assert.equal(
    gitProfileUrl("gitlab", "../admin", "https://gitlab.com/a/b"),
    null,
  );
});
