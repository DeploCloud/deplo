import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerCleanupTab } from "@/app/(dashboard)/[team]/settings/servers/[id]/cleanup-tab";
import { CLEANUP_SCOPES } from "@/lib/data/docker-cleanup/scopes";
import type { CleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import type { CleanupRunDTO } from "@/lib/data/docker-cleanup/run-history";

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "cleanup-test",
};

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
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(
        PathnameContext.Provider,
        { value: "/customer/settings/servers/srv_one" },
        createElement(
          TooltipProvider,
          null,
          createElement(ServerCleanupTab, {
            server: { id: "srv_one", name: "Main" },
            cleanup: { policy: { ...policy, ...over }, runs },
          }),
        ),
      ),
    ),
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
