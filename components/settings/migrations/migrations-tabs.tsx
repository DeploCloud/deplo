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
import type { ImportRun, ServerChoice } from "./types";

/**
 * The two halves of the migrations page: bringing a platform over, and what has
 * already come over.
 *
 * They used to be one column, with "Earlier imports" parked under the connect
 * form - so the person starting their first migration scrolled past an empty
 * card, and the person looking up last week's report had to read the connect
 * form to get to it. Two jobs, two tabs.
 *
 * The active tab rides in `?tab=` with `window.history.replaceState`, the same
 * shape the MCP page uses: flipping tabs neither re-runs the RSC nor fills the
 * back button.
 *
 * `forceMount` on the wizard is load-bearing. Radix unmounts an inactive panel,
 * and the wizard holds the source's API key, the scanned plan and a running
 * migration in state - a stray tab click would have thrown all three away.
 */

const TABS = ["migrate", "history"] as const;
type TabId = (typeof TABS)[number];

export function MigrationsTabs({
  teamId,
  teamName,
  servers,
  buildServers,
  runs,
  isInstanceAdmin,
  canExposePorts,
}: {
  teamId: string;
  teamName: string;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
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
  const [prefill, setPrefill] = React.useState<{
    url: string;
    nonce: number;
  } | null>(null);

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
    <Tabs value={active} onValueChange={selectTab} className="space-y-10">
      {/* `pt-2` plus the page's own gap: the tab bar was sitting right under
          the description, which read as part of the header rather than as the
          thing that switches the page. */}
      <div className="border-b border-border pt-2">
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
          servers={servers}
          buildServers={buildServers}
          isInstanceAdmin={isInstanceAdmin}
          canExposePorts={canExposePorts}
          prefill={prefill}
        />
      </TabsContent>

      <TabsContent value="history">
        <MigrationsHistory
          runs={runs}
          onUseAddress={(run) => {
            setPrefill((p) => ({
              url: run.sourceUrl,
              nonce: (p?.nonce ?? 0) + 1,
            }));
            selectTab("migrate");
          }}
        />
      </TabsContent>
    </Tabs>
  );
}
