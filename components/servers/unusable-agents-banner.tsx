import { ServerCrash } from "lucide-react";

import { Strip } from "@/components/deplo-move/frozen-banner";
import { unusableServers } from "@/lib/data/servers/agent-rollout";
import { unusableAgentsMessage } from "./agent-update-text";

// Instance admins only: the servers this Deplo refuses until their agent updates.
export async function UnusableAgentsBanner() {
  const servers = await unusableServers();
  if (servers.length === 0) return null;
  return (
    <Strip
      icon={ServerCrash}
      message={unusableAgentsMessage(servers)}
      progressHref="/settings/deplo?tab=updates"
      linkLabel="Open Updates"
    />
  );
}
