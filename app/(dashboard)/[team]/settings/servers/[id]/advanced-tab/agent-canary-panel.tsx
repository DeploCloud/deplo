"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { CircleFadingArrowUp } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

export function AgentCanaryPanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [on, setOn] = React.useState(server.agentCanary);

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetServerAgentCanary($id: String!, $agentCanary: Boolean!) {
          setServerAgentCanary(id: $id, agentCanary: $agentCanary) { id }
        }`,
        { id: server.id, agentCanary: next },
      );
      if (!res.ok) {
        setOn(server.agentCanary);
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? `${server.name} is offered canary agent releases`
          : `${server.name} is back on stable agent releases`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleFadingArrowUp className="size-4" />
          Agent updates
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium">
              Canary releases
              <InfoTip
                content="New agent versions before they are marked stable. They can have bugs, and nothing installs until you click Update."
                docs="upgrade.releases"
              />
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {on
                ? "Every new agent version shows up as an update for this server."
                : "Only stable agent versions show up as updates for this server."}
            </p>
          </div>
          <Switch
            checked={on}
            onCheckedChange={toggle}
            disabled={pending}
            aria-label="Canary releases"
          />
        </div>
      </CardContent>
    </Card>
  );
}
