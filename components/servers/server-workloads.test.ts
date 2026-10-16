import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { TooltipProvider } from "@/components/ui/tooltip";
import { MonitoringDashboard } from "@/app/(dashboard)/[team]/monitoring/monitoring-dashboard";
import type { ServerWorkload } from "@/lib/data/servers/workloads";
import { ServerWorkloads } from "./server-workloads";

function render(child: ReactNode, query = "") {
  return renderToStaticMarkup(
    createElement(
      SearchParamsContext.Provider,
      { value: new URLSearchParams(query) },
      createElement(
        PathnameContext.Provider,
        { value: "/customer/monitoring" },
        createElement(TooltipProvider, null, child),
      ),
    ),
  );
}

function workload(over: Partial<ServerWorkload>): ServerWorkload {
  return {
    id: "prj_web",
    kind: "app",
    name: "customer-facing-web-application",
    logo: null,
    logoTone: null,
    engine: null,
    teamName: "Customer experience team",
    teamSlug: "customer",
    teamAvatarUrl: null,
    href: null,
    project: "Customer platform",
    environment: "Production",
    status: "active",
    cpu: 3,
    memUsed: 1024,
    restarts: 0,
    containers: [],
    ...over,
  };
}

const rows = [
  workload({}),
  workload({ id: "prj_off", name: "stopped-app", status: "idle" }),
  workload({
    id: "db_main",
    kind: "database",
    name: "main-database",
    engine: "postgres",
    teamName: "Other team",
    teamSlug: "other",
  }),
];

test("the shared viewer lists all statuses with full team and project names", () => {
  const html = render(
    createElement(ServerWorkloads, { serverId: "srv_one", initial: rows }),
  );
  for (const row of rows) assert.ok(html.includes(row.name));
  assert.ok(html.includes("Customer experience team"));
  assert.ok(html.includes("Customer platform / Production"));
});

test("URL status, type and team filters narrow the shared viewer together", () => {
  const html = render(
    createElement(ServerWorkloads, { serverId: "srv_one", initial: rows }),
    "status=running&type=app&team=customer",
  );
  assert.ok(html.includes("customer-facing-web-application"));
  assert.ok(!html.includes("stopped-app"));
  assert.ok(!html.includes("main-database"));
});

test("a viewer without a seed shows loading rather than an empty server", () => {
  const html = render(createElement(ServerWorkloads, { serverId: "srv_two" }));
  assert.match(html, /role="status"/);
  assert.ok(html.includes("Loading apps"));
  assert.ok(!html.includes("Nothing on this server"));
});

test("Monitoring shows the selected server viewer only to instance admins", () => {
  const props = {
    servers: [
      {
        id: "srv_one",
        name: "Selected server",
        status: "online" as const,
        ip: "192.0.2.10",
        dockerVersion: "28",
        isDeploHost: false,
      },
    ],
    initialHistory: [],
    initialFleet: [],
    canManageServers: true,
  };
  const admin = render(createElement(MonitoringDashboard, props));
  assert.match(admin, /<h2[^>]*>Apps<\/h2>/);
  assert.ok(admin.includes("Loading apps"));
  const member = render(
    createElement(MonitoringDashboard, { ...props, canManageServers: false }),
  );
  assert.doesNotMatch(member, /<h2[^>]*>Apps<\/h2>/);
  assert.ok(!member.includes("Loading apps"));
});
