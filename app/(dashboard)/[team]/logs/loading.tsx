"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { LogPaneSkeleton } from "@/components/logs/log-pane-skeleton";
import { LogChooser } from "@/components/logs/log-targets";
import { LOG_TARGET_COOKIE } from "@/components/logs/log-target";

const remembered = () => document.cookie.includes(`${LOG_TARGET_COOKIE}=`);

// The page opens the remembered or linked log, and the chooser only without either.
export default function Loading() {
  const params = useSearchParams();
  const cookie = React.useSyncExternalStore(
    () => () => {},
    remembered,
    () => true,
  );
  const target =
    params.has("app") || params.has("db") || (cookie && !params.has("pick"));
  if (target) return <LogPaneSkeleton />;
  return <LogChooser rows={[]} loading />;
}
