import { test } from "node:test";
import assert from "node:assert/strict";

import { toHits, type HitContext, type SearchData } from "./search-hits";

const alpha = { id: "t_a", name: "Alpha", slug: "alpha", avatarUrl: null };
const beta = { id: "t_b", name: "Beta", slug: "beta", avatarUrl: null };

const data: SearchData = {
  search: {
    apps: [{ id: "prj_1", name: "Web", slug: "web", logo: null, team: beta }],
    databases: [
      { id: "db_1", name: "Main", logo: null, type: "postgres", team: beta },
    ],
    servers: [{ id: "srv_1", name: "eu-1", host: "10.0.0.1" }],
    projects: [{ id: "prc_1", name: "Shop", team: beta }],
    environments: [
      {
        id: "environ_1",
        name: "Staging",
        projectId: "prc_1",
        projectName: "Shop",
        team: beta,
      },
    ],
    folders: [{ id: "fld_1", name: "Tools", team: beta }],
    domains: [
      {
        id: "dom_1",
        name: "web.acme.com",
        appSlug: "web",
        appName: "Web",
        team: beta,
      },
    ],
    members: [
      {
        userId: "usr_1",
        name: "Ada",
        username: "ada",
        avatarUrl: null,
        avatarColor: "#000",
        team: alpha,
      },
      {
        userId: "usr_1",
        name: "Ada",
        username: "ada",
        avatarUrl: null,
        avatarColor: "#000",
        team: beta,
      },
    ],
    roles: [{ id: "role_1", name: "Owner", memberCount: 1, team: beta }],
    cronJobs: [
      {
        id: "cron_1",
        name: "Nightly",
        targetKind: "app",
        targetRef: "web",
        targetName: "Web",
        team: beta,
      },
    ],
    templates: [{ slug: "ghost", name: "Ghost", logo: null }],
  },
};

const ctx: HitContext = {
  teamId: alpha.id,
  canManageMembers: true,
  isAdmin: true,
};
const hrefs = (c: HitContext = ctx) =>
  Object.fromEntries(toHits(data, c).map((h) => [h.id, h.href]));

test("another team's hit links into that team, never the active one", () => {
  const got = hrefs();
  assert.equal(got["app:prj_1"], "/beta/apps/web");
  assert.equal(got["db:db_1"], "/beta/storage/databases/db_1");
  assert.equal(got["project:prc_1"], "/beta?project=prc_1");
  assert.equal(got["env:environ_1"], "/beta?project=prc_1&env=environ_1");
  assert.equal(got["folder:fld_1"], "/beta?folder=fld_1");
  assert.equal(got["domain:dom_1"], "/beta/apps/web/domains");
  assert.equal(got["role:role_1"], "/beta/settings/roles/role_1");
  assert.equal(got["cron:cron_1"], "/beta/apps/web/cron-jobs");
  assert.equal(got["template:ghost"], "/templates/ghost", "no team to name");
});

test("a member opens where the viewer can actually read them", () => {
  const got = hrefs();
  assert.equal(got["member:t_a:usr_1"], "/alpha/settings/members/usr_1");
  assert.equal(
    got["member:t_b:usr_1"],
    "/beta/settings/members",
    "the detail page needs Manage members, unknown in another team",
  );
  assert.equal(
    hrefs({ ...ctx, canManageMembers: false })["member:t_a:usr_1"],
    "/alpha/settings/members",
  );
});

test("servers are offered only to the instance admin who has their pages", () => {
  assert.equal(hrefs()["server:srv_1"], "/settings/servers/srv_1");
  assert.equal(hrefs({ ...ctx, isAdmin: false })["server:srv_1"], undefined);
});
