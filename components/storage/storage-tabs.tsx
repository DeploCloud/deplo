"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";

const TABS = ["databases", "destinations", "backups"] as const;
export type StorageTabId = (typeof TABS)[number];

/**
 * The three sections of Storage, with the open one in the address bar so a tab
 * can be linked to and survives a reload.
 */
export function StorageTabs({
  defaultTab,
  children,
}: {
  defaultTab: StorageTabId;
  children: React.ReactNode;
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: StorageTabId = (TABS as readonly string[]).includes(
    requested ?? "",
  )
    ? (requested as StorageTabId)
    : defaultTab;

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    // "New ▸ …" is what put us on a tab; picking one by hand overrules it.
    next.delete("new");
    if (tab === "databases") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    // The native History API, not `router.replace`: every panel is already in
    // the browser and re-running the page's server reads to move an underline
    // would be a page load for nothing.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      {children}
    </Tabs>
  );
}
