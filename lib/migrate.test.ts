import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "./migrate";
import type { DeploData } from "./types";

/**
 * A pre-multi-team document: one team on the removed "hobby" plan, one owner
 * user with no membership row, a legacy singleton notificationSettings object,
 * and per-team collections (databases, activities…) missing their teamId.
 */
function legacyDoc(): Record<string, unknown> {
  return {
    users: [
      {
        id: "usr_1",
        email: "a@b.c",
        name: "Owner",
        passwordHash: "scrypt$x$y",
        role: "owner",
        avatarColor: "#50e3c2",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "usr_2",
        email: "m@b.c",
        name: "Member",
        passwordHash: "scrypt$x$y",
        role: "member",
        avatarColor: "#f5a623",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ],
    teams: [
      { id: "team_1", name: "Acme", slug: "acme", plan: "hobby", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    memberships: [],
    invites: [],
    servers: [],
    projects: [],
    deployments: [],
    logs: {},
    envVars: [],
    domains: [],
    databases: [{ id: "db_1", name: "pg", type: "postgres" }],
    s3Destinations: [{ id: "s3_1", name: "r2" }],
    backups: [{ id: "bkp_1", name: "nightly" }],
    apiTokens: [{ id: "tok_1", name: "ci" }],
    activities: [{ id: "act_1", type: "project", message: "x", actor: "Owner", projectId: null }],
    notificationSettings: {
      channels: {
        push: { enabled: false },
        email: { enabled: false, address: "" },
        discord: { enabled: false, webhookUrl: "" },
        webhook: { enabled: false, url: "" },
      },
      events: {
        deployment_failed: true,
        deployment_succeeded: false,
        server_offline: true,
        high_resource_usage: true,
        update_available: true,
      },
    },
    sharedEnvGroups: [{ id: "seg_1", name: "common" }],
    registries: [{ id: "reg_1", name: "ghcr" }],
    githubApps: [{ id: "gha_1", appId: 1 }],
    githubInstallations: [],
    devSshUsers: [],
  };
}

test("migrate: drops the removed hobby plan", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  assert.equal(d.teams[0].plan, "pro");
});

test("migrate: backfills a membership for every user against the first team", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  assert.equal(d.memberships.length, 2);
  const owner = d.memberships.find((m) => m.userId === "usr_1")!;
  assert.equal(owner.teamId, "team_1");
  assert.equal(owner.role, "owner");
  // Owner preset includes the admin capabilities.
  assert.ok(owner.capabilities.includes("manage_members"));
  assert.ok(owner.capabilities.includes("manage_team"));
  const member = d.memberships.find((m) => m.userId === "usr_2")!;
  assert.equal(member.role, "member");
  assert.ok(!member.capabilities.includes("manage_team"));
  assert.ok(member.capabilities.includes("deploy"));
});

test("migrate: backfills a unique username for every user", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  const usernames = d.users.map((u) => u.username);
  assert.ok(usernames.every(Boolean), "every user got a username");
  assert.equal(new Set(usernames).size, usernames.length, "usernames are unique");
});

test("migrate: dedupes usernames when display names collide", () => {
  const d = legacyDoc() as unknown as DeploData;
  // Force a name collision; both should still end with distinct usernames.
  d.users[0].name = "Same Name";
  d.users[1].name = "Same Name";
  migrate(d);
  const [a, b] = d.users.map((u) => u.username);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("same-name"));
  assert.ok(b.startsWith("same-name"));
});

test("migrate: preserves an existing username", () => {
  const d = legacyDoc() as unknown as DeploData;
  d.users[0].username = "preset-handle";
  migrate(d);
  assert.equal(d.users[0].username, "preset-handle");
});

test("migrate: backfills instance-admin onto the first team's owner only", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  const owner = d.users.find((u) => u.id === "usr_1")!; // role "owner"
  const member = d.users.find((u) => u.id === "usr_2")!; // role "member"
  assert.equal(owner.isInstanceAdmin, true);
  assert.equal(member.isInstanceAdmin, false);
  // suspended defaults to false for everyone.
  assert.equal(owner.suspended, false);
  assert.equal(member.suspended, false);
});

test("migrate: does not re-grant instance-admin once the flag exists", () => {
  const d = legacyDoc() as unknown as DeploData;
  // Simulate a post-feature document where admin was deliberately moved.
  d.users[0].isInstanceAdmin = false;
  d.users[1].isInstanceAdmin = true;
  migrate(d);
  assert.equal(d.users[0].isInstanceAdmin, false);
  assert.equal(d.users[1].isInstanceAdmin, true);
});

test("migrate: stamps teamId on legacy per-team collections", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  assert.equal(d.databases[0].teamId, "team_1");
  assert.equal(d.s3Destinations[0].teamId, "team_1");
  assert.equal(d.backups[0].teamId, "team_1");
  assert.equal(d.apiTokens[0].teamId, "team_1");
  assert.equal(d.activities[0].teamId, "team_1");
  assert.equal(d.sharedEnvGroups[0].teamId, "team_1");
  assert.equal(d.registries[0].teamId, "team_1");
  assert.equal(d.githubApps[0].teamId, "team_1");
});

test("migrate: converts the singleton notificationSettings into a per-team map", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  assert.ok(!("channels" in (d.notificationSettings as object)));
  assert.ok(d.notificationSettings["team_1"]);
  assert.equal(d.notificationSettings["team_1"].events.deployment_failed, true);
});

test("migrate: is idempotent", () => {
  const d = legacyDoc() as unknown as DeploData;
  migrate(d);
  const once = JSON.stringify(d);
  migrate(d);
  assert.equal(JSON.stringify(d), once);
});

test("migrate: no team yet (fresh install) is a safe no-op for stamping", () => {
  const d = legacyDoc() as unknown as DeploData;
  d.teams = [];
  d.users = [];
  migrate(d);
  assert.equal(d.memberships.length, 0);
  // notificationSettings still collapses to an (empty) map shape.
  assert.ok(!("channels" in (d.notificationSettings as object)));
});
