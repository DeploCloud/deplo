"use client";

import * as React from "react";
import { useLiveRunning } from "./app-live-status";
import { setAppNav } from "./app-nav-store";

export function AppNavSync({
  slug,
  logo,
  running: serverRunning,
  isGithubApp,
  previewsEnabled,
  pullRequestsOffered,
  cronsEnabled,
  consoleEnabled,
  capabilities,
}: {
  slug: string;
  logo: string | null;
  running: boolean;
  isGithubApp: boolean;
  previewsEnabled: boolean;
  pullRequestsOffered: boolean;
  cronsEnabled: boolean;
  consoleEnabled: boolean;
  capabilities: string[];
}) {
  const running = useLiveRunning(serverRunning);
  const caps = capabilities.join(",");

  React.useEffect(() => {
    setAppNav({
      slug,
      logo,
      running,
      capabilities: caps ? caps.split(",") : [],
      isGithubApp,
      previewsEnabled,
      pullRequestsOffered,
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
    pullRequestsOffered,
    cronsEnabled,
    consoleEnabled,
  ]);

  React.useEffect(() => {
    return () => setAppNav(null);
  }, []);

  return null;
}
