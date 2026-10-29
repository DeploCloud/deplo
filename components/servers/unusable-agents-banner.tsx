import { ServerCrash } from "lucide-react";

import { Strip } from "@/components/deplo-move/frozen-banner";
import { unusableServers } from "@/lib/data/servers/agent-rollout";
import { unusableAgentsMessage } from "./agent-update-text";

// Instance admins only: the servers this Deplo refuses until their server agent updates or is reinstalled.
export async function UnusableAgentsBanner() {
  const servers = await unusableServers();
  if (servers.length === 0) return null;
  // A reinstall starts on the server's own page; an update is followed on the Updates tab.
  const reinstall = servers.every((s) => s.reach === "reinstall");
  const [href, label] = !reinstall
    ? ["/settings/deplo?tab=updates", "Open Updates"]
    : servers.length === 1
      ? [`/settings/servers/${servers[0].id}`, "Open server"]
      : ["/settings/servers", "Open Servers"];
  return (
    <Strip
      icon={ServerCrash}
      message={unusableAgentsMessage(servers)}
      progressHref={href}
      linkLabel={label}
    />
  );
}
