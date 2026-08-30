"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";

// Legacy deep links fold into the two tabs: `instance` was the "All teams" tab,
// now a Teams scope on a shared variable (ADR-0027).
const LEGACY: Record<string, string> = {
  service: "app",
  environments: "app",
  team: "app",
  instance: "shared",
};

/** The Variables page's two tabs, with `?tab=shared` in the URL. */
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
    // The native History API, not `router.replace`: both panels are already in
    // the browser, and re-running every server read to move an underline would
    // be a page load.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      <UnderlineTabsList>
        {/* The value stays `app` - it is what every ?tab= deep link carries. */}
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
