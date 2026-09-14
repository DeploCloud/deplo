"use client";

import * as React from "react";
import { useLiveRunning } from "./app-live-status";
import { setAppNav } from "./app-nav-store";

// AppNavSync - publishes the active app's nav facts into the sidebar store.
export function AppNavSync({
  slug,
  logo,
  running: serverRunning,
  isGithubApp,
  previewsEnabled,
  cronsEnabled,
  consoleEnabled,
  capabilities,
}: {
  slug: string;
  logo: string | null;
  running: boolean;
  isGithubApp: boolean;
  previewsEnabled: boolean;
  cronsEnabled: boolean;
  consoleEnabled: boolean;
  capabilities: string[];
}) {
  const running = useLiveRunning(serverRunning);
  // The array identity changes on every RSC payload; its contents don't.
  const caps = capabilities.join(",");

  React.useEffect(() => {
    setAppNav({
      slug,
      logo,
      running,
      capabilities: caps ? caps.split(",") : [],
      isGithubApp,
      previewsEnabled,
      cronsEnabled,
      consoleEnabled,
    });
  }, [
    slug,
    logo,
    running,
    caps,
    isGithubApp,
    previewsEnabled,
    cronsEnabled,
    consoleEnabled,
  ]);

  // Separate from the publish effect so a live `running` change does not blink the sub-menu.
  React.useEffect(() => {
    return () => setAppNav(null);
  }, []);

  return null;
}
