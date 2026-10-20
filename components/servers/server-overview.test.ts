import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import {
  ServerDetailTabs,
  type ServerSummary,
} from "@/app/(dashboard)/[team]/settings/servers/[id]/server-detail-tabs";
import type { CleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import { renderServerView } from "./server-test-helpers";

const server: ServerSummary = {
  id: "srv_one",
  name: "Main",
  ip: "192.0.2.10",
  host: "main.example",
  agentPort: 9443,
  status: "online",
  cpuCores: 8,
  memoryMb: 16384,
  diskGb: 200,
  dockerVersion: "28.0",
  allTeams: true,
  deployConcurrency: 2,
  role: "everything",
  buildFallback: false,
  generatedAddressFamily: null,
  isDeploHost: false,
  provisioning: false,
  agentVersion: "1.0.0",
  expectedAgentVersion: "1.0.0",
  agentUpdateAvailable: false,
};

const policy: CleanupPolicy = {
  enabled: true,
  schedule: "0 4 * * *",
  minAgeHours: 24,
  keepImagesPerApp: 2,
  scopes: ["build_cache"],
  excludedServerIds: [],
  updatedAt: null,
};

function render(query = "", over: Partial<ServerSummary> = {}) {
  return renderServerView(
    createElement(ServerDetailTabs, {
      server: { ...server, ...over },
      teams: [
        { id: "team_a", name: "Alpha" },
        { id: "team_b", name: "Beta" },
      ],
      accessTeamIds: ["team_a"],
      cleanup: { policy, runs: [] },
      workloads: [],
    }),
    query,
  );
}

test("Overview includes team access and removes the separate Access tab", () => {
  const html = render();
  assert.equal((html.match(/role="tab"/g) ?? []).length, 6);
  assert.ok(html.includes("Save access"));
  assert.equal((html.match(/>Team access</g) ?? []).length, 1);
  assert.ok(html.includes("All teams"));
  assert.ok(html.includes("Specific teams"));
});

test("an old Access link opens Overview with its access controls", () => {
  const html = render("tab=access");
  assert.match(html, /data-state="active"[^>]*>[\s\S]*?Overview<\/button>/);
  assert.ok(html.includes("Save access"));
});

test("specific team selection survives the move into Overview", () => {
  const html = render("", { allTeams: false });
  const checkboxes = [...html.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)];
  assert.equal(checkboxes.length, 2);
  assert.equal(
    checkboxes.filter(([tag]) => tag.includes('data-state="checked"')).length,
    1,
  );
  assert.ok(html.includes("Alpha"));
  assert.ok(html.includes("Beta"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save access<\/button>/);
});

test("Overview retains server settings and readiness controls", () => {
  const html = render();
  assert.match(html, /id="server-display-name"[^>]*value="Main"/);
  assert.match(html, /id="deploy-concurrency"[^>]*value="2"/);
  assert.ok(html.includes("Check readiness"));
  assert.ok(html.includes("Server agent"));
});

test("an available agent update stays actionable in Overview", () => {
  const html = render("", {
    agentUpdateAvailable: true,
    expectedAgentVersion: "1.1.0",
  });
  assert.ok(html.includes("Update to v1.1.0"));
});
