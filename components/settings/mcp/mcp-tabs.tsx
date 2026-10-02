"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Plug, Wrench } from "lucide-react";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { ToolCatalog, ToolSearch, type McpToolSummary } from "./tool-catalog";

export function McpTabs({
  tools,
  children,
}: {
  tools: McpToolSummary[];
  children: React.ReactNode;
}) {
  const params = useSearchParams();
  const active = params.get("tab") === "tools" ? "tools" : "connect";
  const [query, setQuery] = React.useState("");

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "connect") next.delete("tab");
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
          <UnderlineTabsTrigger value="connect">
            <Plug />
            Connect
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="tools">
            <Wrench />
            Tools
          </UnderlineTabsTrigger>
        </UnderlineTabsList>
      </div>

      <TabsContent
        value="connect"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        {children}
      </TabsContent>

      <TabsContent value="tools" className="max-w-3xl space-y-4">
        <div>
          <ToolSearch value={query} onChange={setQuery} />
          <p className="mt-2 text-xs text-muted-foreground">
            An agent only sees the tools its token can use. Secrets are never
            readable through any of them.
          </p>
        </div>
        <ToolCatalog tools={tools} query={query} />
      </TabsContent>
    </Tabs>
  );
}
