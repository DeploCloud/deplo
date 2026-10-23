import { ServerCrash } from "lucide-react";

import { Strip } from "@/components/deplo-move/frozen-banner";
import { unusableServerNames } from "@/lib/data/servers/agent-rollout";

// Instance admins only: the servers this Deplo refuses until their agent updates.
export async function UnusableAgentsBanner() {
  const names = await unusableServerNames();
  if (names.length === 0) return null;
  return (
    <Strip
      icon={ServerCrash}
      message={
        names.length === 1
          ? `${names[0]} is unusable until its agent updates.`
          : `${names.length} servers are unusable until their agents update.`
      }
      progressHref="/settings/deplo?tab=updates"
      linkLabel="Open Updates"
    />
  );
}
