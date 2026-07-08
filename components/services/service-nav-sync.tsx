"use client";

import * as React from "react";
import { useLiveRunning } from "./service-live-status";
import { setServiceNav } from "./service-nav-store";

/**
 * Publishes the active service's nav facts into the sidebar store (see
 * {@link setServiceNav}) so the sidebar can render this service's sub-menu.
 * Rendered inside {@link ServiceLiveStatusProvider} so `running` tracks the live
 * container state — Console/Logs appear and disappear in the sidebar the moment
 * the service starts/stops, exactly as the old horizontal tabs did. Renders
 * nothing itself.
 */
export function ServiceNavSync({
  slug,
  running: serverRunning,
  devEligible,
  showFiles,
}: {
  slug: string;
  /** Server-rendered running state; the live subscription takes over after mount. */
  running: boolean;
  devEligible: boolean;
  showFiles: boolean;
}) {
  const running = useLiveRunning(serverRunning);

  React.useEffect(() => {
    setServiceNav({ slug, running, devEligible, showFiles });
  }, [slug, running, devEligible, showFiles]);

  // Clear only on unmount (leaving the service). Keeping this separate from the
  // publish effect above means a live `running` change re-publishes in place
  // instead of blinking the sub-menu through an empty state.
  React.useEffect(() => {
    return () => setServiceNav(null);
  }, []);

  return null;
}
