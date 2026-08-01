"use client";

import * as React from "react";
import { useLiveRunning } from "./app-live-status";
import { setAppNav } from "./app-nav-store";

/**
 * Publishes the active app's nav facts into the sidebar store (see
 * {@link setAppNav}) so the sidebar can render this app's sub-menu.
 * Rendered inside {@link AppLiveStatusProvider} so `running` tracks the live
 * container state — Console/Logs appear and disappear in the sidebar the moment
 * the app starts/stops, exactly as the old horizontal tabs did. Renders
 * nothing itself.
 */
export function AppNavSync({
  slug,
  running: serverRunning,
  showFiles,
}: {
  slug: string;
  /** Server-rendered running state; the live subscription takes over after mount. */
  running: boolean;
  showFiles: boolean;
}) {
  const running = useLiveRunning(serverRunning);

  React.useEffect(() => {
    setAppNav({ slug, running, showFiles });
  }, [slug, running, showFiles]);

  // Clear only on unmount (leaving the app). Keeping this separate from the
  // publish effect above means a live `running` change re-publishes in place
  // instead of blinking the sub-menu through an empty state.
  React.useEffect(() => {
    return () => setAppNav(null);
  }, []);

  return null;
}
