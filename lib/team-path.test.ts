import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  RESERVED_TEAM_SLUGS,
  flatPath,
  pickActiveTeam,
  pickTeamSlug,
  teamSlugFromPath,
  withTeam,
} from "./team-path";

test("prefixes a dashboard path, query and hash included", () => {
  assert.equal(withTeam("/apps/web", "acme"), "/acme/apps/web");
  assert.equal(
    withTeam("/apps/web/deployments/dep_1", "acme"),
    "/acme/apps/web/deployments/dep_1",
  );
  assert.equal(
    withTeam("/logs?app=web#tail", "acme"),
    "/acme/logs?app=web#tail",
  );
  assert.equal(withTeam("/", "acme"), "/acme");
  assert.equal(withTeam("/settings", "acme"), "/acme/settings");
});

test("leaves a path that belongs to no team", () => {
  for (const p of [
    "/login",
    "/login?next=%2Fapps",
    "/setup",
    "/register/tok_1",
    "/welcome",
    "/takeover",
    "/oauth/consent",
    "/api/graphql",
    "/api/apps/prj_1/logs",
    "/install",
    "/_next/static/x",
  ])
    assert.equal(withTeam(p, "acme"), p);
});

test("leaves an asset alone, page or not", () => {
  // /templates is the page and moves; /templates/n8n.svg is public/ and does not.
  assert.equal(withTeam("/templates", "acme"), "/acme/templates");
  assert.equal(withTeam("/templates/n8n.svg", "acme"), "/templates/n8n.svg");
  assert.equal(withTeam("/logo.svg", "acme"), "/logo.svg");
  assert.equal(
    withTeam("/engines/postgres.svg", "acme"),
    "/engines/postgres.svg",
  );
  assert.equal(withTeam("/sw.js", "acme"), "/sw.js");
});

test("leaves anything that is not an internal path", () => {
  for (const p of [
    "https://deplo.build/docs",
    "//example.com/x",
    "mailto:a@b.c",
    "#tail",
    "?tab=1",
    "apps/web",
    "",
  ])
    assert.equal(withTeam(p, "acme"), p);
});

test("is idempotent and needs a slug", () => {
  assert.equal(withTeam("/acme/apps/web", "acme"), "/acme/apps/web");
  assert.equal(withTeam("/apps/web", null), "/apps/web");
  assert.equal(withTeam("/apps/web", ""), "/apps/web");
});

test("reads the team out of a path", () => {
  assert.equal(teamSlugFromPath("/acme/apps/web"), "acme");
  assert.equal(teamSlugFromPath("/acme"), "acme");
  assert.equal(teamSlugFromPath("/apps/web"), null);
  assert.equal(teamSlugFromPath("/settings/members"), null);
  assert.equal(teamSlugFromPath("/logo.svg"), null);
  assert.equal(teamSlugFromPath("/"), null);
});

test("flatPath is the inverse of withTeam", () => {
  for (const p of ["/", "/apps/web", "/logs?app=web", "/settings/members"])
    assert.equal(flatPath(withTeam(p, "acme")), p);
  // Already flat, or flat for good: unchanged either way.
  assert.equal(flatPath("/apps/web"), "/apps/web");
  assert.equal(flatPath("/login"), "/login");
  assert.equal(flatPath("/acme"), "/");
});

/**
 * The guard that keeps the list honest: a new top-level route a team could be
 * named after would make that team unreachable.
 */
test("every first segment the app tree serves is reserved", () => {
  const root = path.join(process.cwd(), "app");
  const segments: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("(")) {
      for (const child of readdirSync(path.join(root, entry.name), {
        withFileTypes: true,
      }))
        if (child.isDirectory()) segments.push(child.name);
      continue;
    }
    segments.push(entry.name);
  }
  for (const seg of segments) {
    // A dotted name is a file route (/robots.txt), a bracketed one is the team
    // segment itself - neither can be confused with a team.
    if (seg.includes(".") || seg.startsWith("[")) continue;
    assert.ok(
      RESERVED_TEAM_SLUGS.has(seg),
      `"${seg}" is a route but not a reserved team slug`,
    );
  }
});

test("mints a slug that is free and never a route name", () => {
  assert.equal(pickTeamSlug("Idra Arts", []), "idra-arts");
  assert.equal(pickTeamSlug("Idra Arts", ["idra-arts"]), "idra-arts-2");
  assert.equal(
    pickTeamSlug("Idra Arts", ["idra-arts", "idra-arts-2"]),
    "idra-arts-3",
  );
  // A name that slugs onto a route would be unreachable at /<slug>.
  assert.equal(pickTeamSlug("Apps", []), "apps-2");
  assert.equal(pickTeamSlug("Settings", []), "settings-2");
  assert.equal(pickTeamSlug("!!!", []), "team");
  for (const name of ["Apps", "Logs", "New", "API", "Login"])
    assert.equal(teamSlugFromPath(`/${pickTeamSlug(name, [])}`) !== null, true);
});

test("the URL's team wins over the last visited one", () => {
  const teams = [
    { id: "team_a", slug: "acme" },
    { id: "team_b", slug: "idra" },
  ];
  const pick = (url: string | null, cookie?: string | null) =>
    pickActiveTeam(teams, url, cookie).id;

  assert.equal(pick("idra", "acme"), "team_b");
  assert.equal(pick(null, "acme"), "team_a");
  assert.equal(pick(null, null), "team_a", "falls back to the first team");
  // Id or slug, on either source.
  assert.equal(pick("team_b"), "team_b");
  assert.equal(pick(null, "team_b"), "team_b");
  // A team the user is not in selects NOTHING - an invented header or cookie is
  // worth exactly as much as no header at all.
  assert.equal(pick("team_stranger", "idra"), "team_b");
  assert.equal(pick("stranger", null), "team_a");
  assert.equal(pick("", ""), "team_a");
});

test("a path that already names a team is left alone", () => {
  // Nothing but a team can hold a first segment, so an unknown one is a team's -
  // and the team switcher's own `/idra` must not become `/acme/idra`.
  assert.equal(withTeam("/idra", "acme"), "/idra");
  assert.equal(withTeam("/idra/apps/web", "acme"), "/idra/apps/web");
  assert.equal(withTeam("/acme", "acme"), "/acme");
});

test("the root keeps its query where it belongs", () => {
  assert.equal(withTeam("/?project=prj_1", "acme"), "/acme?project=prj_1");
  assert.equal(withTeam("/#tail", "acme"), "/acme#tail");
});
