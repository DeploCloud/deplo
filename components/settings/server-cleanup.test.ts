import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { formatBytes } from "@/lib/utils";
import { renderServerView } from "@/components/servers/server-test-helpers";
import { ServerCleanupTab } from "@/app/(dashboard)/[team]/settings/servers/[id]/cleanup-tab";
import { CLEANUP_SCOPES } from "@/lib/data/docker-cleanup/scopes";
import type { CleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import type { CleanupRunDTO } from "@/lib/data/docker-cleanup/run-history";

const policy: CleanupPolicy = {
  enabled: true,
  schedule: "0 4 * * *",
  minAgeHours: 24,
  keepImagesPerApp: 2,
  scopes: [...CLEANUP_SCOPES],
  excludedServerIds: [],
  updatedAt: null,
};

function render(over: Partial<CleanupPolicy> = {}, runs: CleanupRunDTO[] = []) {
  return renderServerView(
    createElement(ServerCleanupTab, {
      server: { id: "srv_one", name: "Main" },
      cleanup: { policy: { ...policy, ...over }, runs },
    }),
  );
}

function control(html: string, id: string) {
  const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  assert.ok(match, id);
  return match[0];
}

test("excluding one server leaves the shared schedule enabled", () => {
  const html = render({ excludedServerIds: ["srv_one"] });
  assert.match(control(html, "cleanup-included"), /data-state="unchecked"/);
  assert.match(control(html, "cleanup-enabled"), /data-state="checked"/);
  assert.ok(html.includes("Changes here apply to every server."));
});

test("a regular cleanup schedule shows frequency and time in UTC", () => {
  const html = render();
  assert.match(control(html, "cleanup-schedule"), /role="combobox"/);
  assert.ok(html.includes("Time (UTC)"));
  assert.match(html, /id="cleanup-schedule-time"[^>]*value="04:00"/);
  for (const scope of CLEANUP_SCOPES) {
    assert.match(
      control(html, `cleanup-scope-${scope}`),
      /data-state="checked"/,
    );
  }
});

test("custom cleanup schedules keep their exact cron expression", () => {
  const html = render({ schedule: "17 3 1,15 * *" });
  assert.ok(html.includes('aria-label="Cron expression"'));
  assert.ok(html.includes('value="17 3 1,15 * *"'));
});

test("a cleanup in progress keeps the manual action disabled", () => {
  const html = render({}, [
    {
      id: "cleanup_one",
      serverId: "srv_one",
      serverName: "Main",
      trigger: "manual",
      actor: "Admin",
      status: "running",
      error: null,
      reclaimedBytes: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      items: [],
    },
  ]);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Cleaning up/);
  assert.ok(html.includes("Recent cleanups"));
});

test("zero eligible items explains the cleanup rules", () => {
  const html = render({}, [
    {
      id: "empty",
      serverId: "srv_one",
      serverName: "Main",
      trigger: "manual",
      actor: "Admin",
      status: "success",
      error: null,
      reclaimedBytes: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      items: [],
    },
  ]);
  assert.ok(html.includes("No items eligible under the cleanup rules"));
  assert.ok(!html.includes("Nothing to reclaim"));
});

test("failed cleanups still show the bytes reclaimed before the error", () => {
  const html = render({}, [
    {
      id: "partial",
      serverId: "srv_one",
      serverName: "Main",
      trigger: "manual",
      actor: "Admin",
      status: "failed",
      error: "permission denied",
      reclaimedBytes: 1073741824,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      items: [],
    },
  ]);
  assert.ok(html.includes(formatBytes(1073741824)));
  assert.ok(html.includes("permission denied"));
});
