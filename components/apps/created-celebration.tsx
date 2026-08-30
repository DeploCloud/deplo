"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { ConfettiBurst } from "@/components/shared/confetti-burst";

/** How long the two cannons hold the screen. */
const SHOW_MS = 4000;

/**
 * The celebration a brand-new app lands on. The flag comes from the URL the
 * wizard pushed and is stripped on arrival, so a reload (or a shared link) is
 * just the deployment page.
 */
export function CreatedCelebration({ created }: { created: boolean }) {
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    if (!created) return;
    // The History API, not the router: a router replace would re-render this
    // away before the burst is over.
    const url = new URL(window.location.href);
    url.searchParams.delete("created");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    const timer = setTimeout(() => setDone(true), SHOW_MS);
    return () => clearTimeout(timer);
  }, [created]);

  if (!created || done) return null;
  return <ConfettiBurst cannons count={64} className="z-50" />;
}
