"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";

const TABS = ["databases", "destinations", "backups"] as const;
export type StorageTabId = (typeof TABS)[number];

// StorageTabs - the three sections of Storage, with the open one in the address bar.
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
    // Native History API, not `router.replace`: moving an underline must not re-run the page's server reads.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-3">
      {children}
    </Tabs>
  );
}
