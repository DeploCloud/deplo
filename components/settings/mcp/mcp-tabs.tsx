"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Plug, SlidersHorizontal } from "lucide-react";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { ConnectWizard } from "./connect-wizard";
import { McpPanel } from "./mcp-panel";
import { ConnectedClients } from "./connected-clients";
import { ToolsDialogLink, type McpToolSummary } from "./tools-dialog";
import type { McpConnectionDTO } from "@/lib/data/mcp-clients";
import type { ScopeTreeTeam } from "@/lib/data/tokens";

/**
 * The two halves of the MCP page: getting an agent in, and living with the ones
 * that are already in.
 *
 * They were one stack of five cards, which meant the person connecting their
 * first agent read past a kill switch and a table of seventy-eight tools to
 * reach the one line they came for, and the admin auditing access scrolled past
 * connection instructions to reach the revoke buttons. Two different jobs, two
 * different people, one screen serving neither.
 *
 * The active tab rides in `?tab=` with `window.history.replaceState`, the same
 * shape the server detail page uses — a link can then point at what is being
 * talked about ("revoke it under Manage") rather than at a page plus
 * directions, and flipping tabs neither re-runs the RSC nor fills the back
 * button.
 *
 * `forceMount` on Connect is load-bearing. Radix unmounts an inactive panel,
 * and the wizard holds a minted token's secret in state — a stray tab click
 * would have destroyed the one screen where that secret is ever visible.
 */

const TABS = ["connect", "manage"] as const;
type TabId = (typeof TABS)[number];

export function McpTabs({
  enabled,
  canManageMcp,
  canManageTokens,
  publicUrl,
  tree,
  activeTeamId,
  tools,
  connections,
}: {
  enabled: boolean;
  canManageMcp: boolean;
  canManageTokens: boolean;
  publicUrl: string;
  tree: ScopeTreeTeam[];
  activeTeamId: string;
  tools: McpToolSummary[];
  connections: McpConnectionDTO[];
}) {
  const params = useSearchParams();
  // Managing needs one of the two capabilities to be worth opening: the switch
  // is `manage_mcp`, revoking is `manage_tokens`, and someone holding neither
  // would get a read-only list of other people's credentials.
  const canManage = canManageMcp || canManageTokens;

  const requested = params.get("tab");
  const active: TabId =
    canManage && (TABS as readonly string[]).includes(requested ?? "")
      ? (requested as TabId)
      : "connect";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "connect") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    // The native History API, not `router.replace`: the panels are already in
    // the browser and re-running every server read for a query parameter would
    // be a page load to move a underline.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border">
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="connect">
            <Plug />
            Connect
          </UnderlineTabsTrigger>
          {canManage && (
            <UnderlineTabsTrigger value="manage">
              <SlidersHorizontal />
              Manage
            </UnderlineTabsTrigger>
          )}
        </UnderlineTabsList>
        {/* The tool list, out of the way but never more than one click off. */}
        <ToolsDialogLink tools={tools} className="pb-3" />
      </div>

      <TabsContent value="connect" forceMount className="data-[state=inactive]:hidden">
        <ConnectWizard
          mcpEnabled={enabled}
          canManageMcp={canManageMcp}
          canManageTokens={canManageTokens}
          publicUrl={publicUrl}
          tree={tree}
          activeTeamId={activeTeamId}
          tools={tools}
          connectionCount={connections.length}
          onGoToManage={() => canManage && selectTab("manage")}
        />
      </TabsContent>

      {canManage && (
        <TabsContent value="manage" className="space-y-6">
          <McpPanel enabled={enabled} canManage={canManageMcp} />
          <ConnectedClients
            connections={connections}
            canManage={canManageTokens}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}
