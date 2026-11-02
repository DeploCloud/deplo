"use client";

import * as React from "react";
import { useFlatPathname } from "@/lib/nav";
import { MobileMorePanel } from "./mobile-more-panel";
import { MobileTabBar } from "./mobile-tab-bar";
import { startPwa } from "./pwa";
import type { PublicUser } from "@/lib/types/identity";
import type { TeamIdentity, TeamSummary } from "@/lib/types/team";

export function MobileNav(props: {
  user: PublicUser;
  team: TeamIdentity;
  teams: TeamSummary[];
  capabilities: string[];
  isAdmin: boolean;
  hasSecondFactor: boolean;
}) {
  const pathname = useFlatPathname();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [shownFor, setShownFor] = React.useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setMoreOpen(false);
  }
  const close = React.useCallback(() => setMoreOpen(false), []);
  React.useEffect(startPwa, []);

  return (
    <>
      {moreOpen && <MobileMorePanel {...props} onClose={close} />}
      <MobileTabBar
        capabilities={props.capabilities}
        moreOpen={moreOpen}
        onMore={() => setMoreOpen((o) => !o)}
        onNavigate={close}
      />
    </>
  );
}
