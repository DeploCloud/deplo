"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Cable, History } from "lucide-react";

import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { MigrationWizard } from "./migration-wizard";
import { MigrationsHistory } from "./migrations-history";
import type { ImportRun, ServerChoice } from "./types";

/**
 * The two halves of the migrations page: bringing a platform over, and what has
 * already come over.
 */

const TABS = ["migrate", "history"] as const;
type TabId = (typeof TABS)[number];

export function MigrationsTabs({
  teamId,
  teamName,
  teamAvatarUrl,
  servers,
  buildServers,
  runs,
  resumable,
  isInstanceAdmin,
  canExposePorts,
}: {
  teamId: string;
  teamName: string;
  teamAvatarUrl: string | null;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
  /** The run the wizard opens on: the team's, if one is in flight, or one whose
   *  report this person has not closed yet. Null for the empty connect form. */
  resumable: ImportRun | null;
  isInstanceAdmin: boolean;
  canExposePorts: boolean;
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "migrate";

  /**
   * An address handed over from the History tab. The nonce is what makes
   * picking the SAME run twice still land in the field - the wizard reacts to
   * the object identity, and a bare string would look unchanged.
   */
  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "migrate") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    // The native History API, not `router.replace`: both panels are already in
    // the browser, and re-running every server read to move an underline would
    // be a page load for nothing.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-3">
      <div className="border-b border-border">
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="migrate">
            <Cable />
            Migrate
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="history">
            <History />
            History
          </UnderlineTabsTrigger>
        </UnderlineTabsList>
      </div>

      <TabsContent
        value="migrate"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <MigrationWizard
          teamId={teamId}
          teamName={teamName}
          teamAvatarUrl={teamAvatarUrl}
          servers={servers}
          buildServers={buildServers}
          isInstanceAdmin={isInstanceAdmin}
          canExposePorts={canExposePorts}
          resumable={resumable}
        />
      </TabsContent>

      <TabsContent value="history">
        <MigrationsHistory runs={runs} />
      </TabsContent>
    </Tabs>
  );
}
