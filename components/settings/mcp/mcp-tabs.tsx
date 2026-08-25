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
import { RobotMark } from "./robot-graphic";
import { cn } from "@/lib/utils";
import type { McpConnectionDTO } from "@/lib/data/mcp-clients";
import type { ScopeTreeTeam } from "@/lib/data/tokens";

/**
 * The two halves of the MCP page: getting an agent in, and living with the ones
 * that are already in.
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
        {/* The one number worth having in view from both tabs: how many agents
            can act in this team right now. Zero is a real answer and says so. */}
        <ConnectedCount
          count={connections.length}
          onOpen={canManage ? () => selectTab("manage") : undefined}
        />
      </div>

      <TabsContent
        value="connect"
        forceMount
        className="data-[state=inactive]:hidden"
      >
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
          {/**
           * The tool list closes the tab as a footnote: it is reference, not a control, and
           * the person here is auditing access rather than wondering what an agent can reach.
           */}
          <p className="border-t border-border pt-4">
            <ToolsDialogLink tools={tools} />
          </p>
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * How many agents can act in this team, beside the tabs.
 */
function ConnectedCount({
  count,
  onOpen,
}: {
  count: number;
  onOpen?: () => void;
}) {
  const label = `${count} ${count === 1 ? "agent" : "agents"} connected`;
  const inner = (
    <>
      <RobotMark />
      {label}
    </>
  );
  const shared = "group inline-flex items-center gap-1.5 pb-3 text-sm";

  if (!onOpen)
    return <span className={cn(shared, "text-muted-foreground")}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        shared,
        "cursor-pointer text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline",
        "focus-visible:text-foreground focus-visible:underline focus-visible:outline-none",
      )}
    >
      {inner}
    </button>
  );
}
