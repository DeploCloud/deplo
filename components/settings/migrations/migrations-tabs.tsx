"use client";

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
import type { ImportRun, ServerChoice, TargetTeam } from "./types";

/**
 * The two halves of the migrations page: bringing a panel over, and what has
 * already come over - every team's, since the page is the instance's.
 */

const TABS = ["migrate", "history"] as const;
type TabId = (typeof TABS)[number];

export function MigrationsTabs({
  teamId,
  targetTeams,
  servers,
  buildServers,
  runs,
  resumable,
  sameMachineHost,
  canExposePorts,
}: {
  /** The page's team - where the source machines are registered. */
  teamId: string;
  /** Every team a source team could land in. */
  targetTeams: TargetTeam[];
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
  /** The run the wizard opens on: one in flight, or one whose report this person
   *  has not closed yet, whichever team it landed in. Null for the empty form. */
  resumable: ImportRun | null;
  /** The address a container on this instance reaches its own host on. */
  sameMachineHost: string;
  canExposePorts: boolean;
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "migrate";

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
        {/* The page itself is instance-admin only, so the wizard's admin-gated
            steps are always on here. */}
        <MigrationWizard
          teamId={teamId}
          targetTeams={targetTeams}
          servers={servers}
          buildServers={buildServers}
          isInstanceAdmin
          canExposePorts={canExposePorts}
          resumable={resumable}
          sameMachineHost={sameMachineHost}
        />
      </TabsContent>

      <TabsContent value="history">
        <MigrationsHistory runs={runs} />
      </TabsContent>
    </Tabs>
  );
}
