"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";

// Legacy deep links fold into the two tabs: `instance` is now a Teams scope (ADR-0027).
const LEGACY: Record<string, string> = {
  service: "app",
  environments: "app",
  team: "app",
  instance: "shared",
};

// VariablesTabs - the Variables page's two tabs, with `?tab=shared` in the URL.
export function VariablesTabs({
  all,
  shared,
}: {
  all: React.ReactNode;
  shared: React.ReactNode;
}) {
  const params = useSearchParams();
  const raw = params.get("tab");
  const requested = raw ? (LEGACY[raw] ?? raw) : "app";
  const active = requested === "shared" ? "shared" : "app";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "app") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      <UnderlineTabsList>
        {/* The value stays `app` - what every ?tab= deep link carries. */}
        <UnderlineTabsTrigger value="app">All</UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="shared">Shared</UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="app" className="space-y-4">
        {all}
      </TabsContent>
      <TabsContent value="shared">{shared}</TabsContent>
    </Tabs>
  );
}
