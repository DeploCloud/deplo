import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appTypeLabel,
  cn,
  formatBuildDuration,
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
  // Light backgrounds → dark text; dark backgrounds → light text.
  assert.equal(readableTextColor("#ffffff"), "#000000");
  assert.equal(readableTextColor("#000000"), "#ffffff");
  assert.equal(readableTextColor("#facc15"), "#000000"); // light yellow
  assert.equal(readableTextColor("#f59e0b"), "#000000"); // amber
  assert.equal(readableTextColor("#1e1b4b"), "#ffffff"); // near-black navy
  // Shorthand and a missing # are tolerated.
  assert.equal(readableTextColor("fff"), "#000000");
  assert.equal(readableTextColor("#000"), "#ffffff");
  // An unparseable value falls back to a safe dark foreground (never throws).
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
  // An upload keeps a stale compose around for switching back — still a
  // single-image build, so it must not read as a stack.
  assert.equal(
    appTypeLabel({ ...base, source: "upload", compose: "services: {}" }),
    "Application",
  );
  assert.equal(appTypeLabel({ ...base, source: "compose" }), "Compose app");
  // Legacy template apps: a stored compose with no repo/image.
  assert.equal(
    appTypeLabel({ ...base, source: "git", compose: "services: {}" }),
    "Compose app",
  );
});

test("formatBuildDuration rounds DOWN so a live timer never over-reports", () => {
  // The same formatter drives the ticking "Build time" on the deployment page,
  // so a build 400ms in must read 400ms, never a second it hasn't reached.
  assert.equal(formatBuildDuration(1_999), "1s");
  assert.equal(formatBuildDuration(45_000), "45s");
  assert.equal(formatBuildDuration(59_999), "59s");
  assert.equal(formatBuildDuration(60_000), "1m 0s");
  assert.equal(formatBuildDuration(125_000), "2m 5s");
});

test("formatBuildDuration: a sub-second build reports milliseconds, not 0s", () => {
  // A redeploy that only restarts a container really does finish in a few
  // hundred ms — "0s" would read as "we didn't measure it".
  assert.equal(formatBuildDuration(400), "400ms");
  assert.equal(formatBuildDuration(7), "7ms");
  assert.equal(formatBuildDuration(999), "999ms");
  // Fractions round down too, and the unit flips exactly at a full second.
  assert.equal(formatBuildDuration(12.9), "12ms");
  assert.equal(formatBuildDuration(999.9), "999ms");
  assert.equal(formatBuildDuration(1_000), "1s");
});

test("formatBuildDuration: no duration renders empty, a negative one clamps to 0ms", () => {
  // Null = never measured (still queued, or a build orphaned by a restart) —
  // the caller renders its own placeholder rather than a fabricated duration.
  assert.equal(formatBuildDuration(null), "");
  // A viewer's clock running ahead of the host's must not show a negative build.
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
  // CardTitle ships "text-base lg:text-lg" and ~55 call sites still pass their own
  // "text-base". tailwind-merge keys the font-size group on the modifier, so the bare
  // one is replaced and the lg: one survives - which is the ONLY reason every card
  // title grows on a wide screen without touching 55 files.
  const merged = cn(
    "text-base leading-none font-semibold tracking-tight lg:text-lg",
    "flex w-fit items-center gap-2 text-base",
  );
  assert.match(merged, /\blg:text-lg\b/);
  assert.match(merged, /\btext-base\b/);

  // A call site that pins BOTH sizes wins on both (the login/monitoring cards).
  const pinned = cn(
    "text-base font-semibold lg:text-lg",
    "text-2xl lg:text-2xl",
  );
  assert.doesNotMatch(pinned, /\blg:text-lg\b/);
  assert.doesNotMatch(pinned, /(^|\s)text-base(\s|$)/);
});

test("pickerInstallationId never invents a GitHub App for an app that already has a repo", () => {
  const insts = [{ id: "gi_first" }, { id: "gi_real" }];
  // A NEW app asserts nothing yet, so opening on the first App is helpful.
  assert.equal(pickerInstallationId(undefined, insts), "gi_first");
  // A properly connected app opens on its OWN App.
  assert.equal(
    pickerInstallationId({ installationId: "gi_real" }, insts),
    "gi_real",
  );
  // An imported app: repo set, credential NULL. This used to answer "gi_first",
  // which is how the UI came to claim a connection the database never had.
  assert.equal(pickerInstallationId({ installationId: null }, insts), "");
  // A re-installed App re-keys the row: the stored id no longer exists. Same
  // class of lie, same answer.
  assert.equal(pickerInstallationId({ installationId: "gi_gone" }, insts), "");
  assert.equal(pickerInstallationId(undefined, []), "");
});

test("only a row that claims a GitHub App it lacks is flagged", () => {
  const bare = { installationId: null, connectionId: null };
  // The real broken row: source github, both credential columns NULL.
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
  // A bare Repository URL is the documented use of that source, not a fault:
  // an anonymous clone of a PUBLIC repo deploys fine. Widening the predicate to
  // "no credential" would flag it, and a warning on a healthy app is noise.
  assert.equal(repoCredentialMissing({ source: "git", repo: bare }), false);
  assert.equal(
    repoCredentialMissing({ source: "docker-image", repo: null }),
    false,
  );
  assert.equal(repoCredentialMissing({ source: "github", repo: null }), false);
});

/**
 * `safeReturnPath` is what stands between "come back where you were" and an open
 * redirect: the return address arrives from the browser (a `?next=`, a `returnTo`
 * argument), so anything that could leave the app has to answer `null` rather than
 * being trusted because it was signed later.
 */
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
    // An API route is never a page to land on, and the GitHub routes in
    // particular would re-enter the flow that issued the address.
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
