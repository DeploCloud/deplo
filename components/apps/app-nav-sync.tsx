"use client";

import * as React from "react";
import { useLiveRunning } from "./app-live-status";
import { setAppNav } from "./app-nav-store";

/**
 * Publishes the active app's nav facts into the sidebar store (see {@link
 * setAppNav}) so the sidebar can render this app's sub-menu.
 */
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
  /** The app's own logo - the mark on its Overview entry. */
  logo: string | null;
  /** Server-rendered running state; the live subscription takes over after mount. */
  running: boolean;
  isGithubApp: boolean;
  previewsEnabled: boolean;
  cronsEnabled: boolean;
  consoleEnabled: boolean;
  /** The viewer's capabilities on this app - gates the sub-menu's entries. */
  capabilities: string[];
}) {
  const running = useLiveRunning(serverRunning);
  // The array identity changes on every RSC payload; its contents don't, so key
  // the effect on the contents or it would re-publish on every render.
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

  // Clear only on unmount (leaving the app). Keeping this separate from the
  // publish effect above means a live `running` change re-publishes in place
  // instead of blinking the sub-menu through an empty state.
  React.useEffect(() => {
    return () => setAppNav(null);
  }, []);

  return null;
}
