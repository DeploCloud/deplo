import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { StatusBadge } from "@/components/shared/status-badge";
import { DatabaseStandbyForm } from "@/components/storage/database-standby-form";
import { StickySessionsForm } from "./sticky-sessions-form";

// The switches and the badge spec #176 names word for word, as the page renders them.
const text = (el: ReactElement) =>
  renderServerView(el).replace(/<[^>]+>/g, " ");

test("the sticky switch reads Keep each visitor on the same replica", () => {
  assert.match(
    text(createElement(StickySessionsForm, { appId: "prj_1", enabled: false })),
    /Keep each visitor on the same replica/,
  );
});

test("a database is offered Keep a standby copy, with what it costs", () => {
  const cost =
    "Uses 512 MB on a second server and a second copy of its data (1 GB).";
  const row = text(
    createElement(DatabaseStandbyForm, {
      databaseId: "db_1",
      standby: {
        enabled: false,
        byCluster: null,
        unavailable: null,
        cost,
        serverName: null,
        note: null,
      },
    }),
  );
  assert.match(row, /Keep a standby copy/);
  assert.ok(row.includes(cost));
});

test("an App whose restarts paused reads Not answering · restarts paused", () => {
  assert.match(
    text(createElement(StatusBadge, { status: "unresponsive" })),
    /Not answering · restarts paused/,
  );
});

test("a database on a cluster that replicates reads that the cluster keeps its copy", () => {
  const row = text(
    createElement(DatabaseStandbyForm, {
      databaseId: "db_1",
      standby: {
        enabled: true,
        byCluster: "eu",
        unavailable: null,
        cost: "",
        serverName: "server-b",
        note: "The copy runs on server-b. A failover promotes it.",
      },
    }),
  );
  assert.match(
    row,
    /Cluster eu replicates its databases, so it keeps this copy\./,
  );
});
