"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Cable, History, Truck } from "lucide-react";

import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { MoveInCard } from "@/components/deplo-move/move-in-card";
import { MoveOutCard } from "@/components/deplo-move/move-out-card";
import type { SourceMoveStatus } from "@/lib/data/deplo-move/source";
import { MigrationWizard } from "./migration-wizard/wizard";
import { MigrationsHistory } from "./migrations-history";
import type { ImportRun, ServerChoice, TargetTeam } from "./types";

const TABS = ["migrate", "history", "move"] as const;
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
  move,
}: {
  teamId: string;
  targetTeams: TargetTeam[];
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
  resumable: ImportRun | null;
  sameMachineHost: string;
  canExposePorts: boolean;
  move: {
    source: SourceMoveStatus | null;
    // A move into this Deplo that has already started.
    activeTargetId: string | null;
    readiness: { ready: boolean; reason: string | null };
  };
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
          <UnderlineTabsTrigger value="move">
            <Truck />
            Move Deplo
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

      {/* Mounted while hidden, so a move code shown once survives a look at another tab. */}
      <TabsContent
        value="move"
        forceMount
        className="space-y-4 data-[state=inactive]:hidden"
      >
        <MoveOutCard
          initial={move.source}
          incoming={move.activeTargetId !== null}
        />
        <MoveInCard activeId={move.activeTargetId} readiness={move.readiness} />
      </TabsContent>
    </Tabs>
  );
}
