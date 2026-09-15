"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";

const TABS = ["databases", "destinations", "backups"] as const;
export type StorageTabId = (typeof TABS)[number];

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
    next.delete("new");
    if (tab === "databases") next.delete("tab");
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
      {children}
    </Tabs>
  );
}
