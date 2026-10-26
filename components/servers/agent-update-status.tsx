"use client";

import * as React from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { agentLinks } from "@/lib/version";
import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import { agentUpdateText } from "./agent-update-text";

const FIELDS = `
  running
  failed
  gaveUp
  attempts
  failure
  lastError
  firstFailedAt
  nextRetryAt
`;

/** The state line and, only after Deplo's own attempt failed, Retry now. */
export function AgentUpdateStatus({
  serverId,
  usable,
  version,
  update,
  onSettled,
}: {
  serverId: string;
  usable: boolean;
  /** The version its agent last reported; null when unknown. */
  version: string | null;
  update: AgentUpdateDTO | null;
  onSettled?: () => void;
}) {
  const [live, setLive] = React.useState<{
    from: AgentUpdateDTO | null;
    value: AgentUpdateDTO | null;
  } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const current = live && live.from === update ? live.value : update;
  const settled = React.useEffectEvent(() => onSettled?.());

  const watching = Boolean(current && !current.gaveUp);
  const running = Boolean(current?.running);
  React.useEffect(() => {
    if (!watching) return;
    const timer = setInterval(
      async () => {
        try {
          const data = await gql<{
            server: { agentUpdate: AgentUpdateDTO | null } | null;
          }>(
            /* GraphQL */ `query AgentUpdate($id: String!) { server(id: $id) { agentUpdate { ${FIELDS} } } }`,
            { id: serverId },
          );
          const value = data.server?.agentUpdate ?? null;
          setLive({ from: update, value });
          if (running && !value?.running) settled();
        } catch {}
      },
      running ? 3000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [watching, running, serverId, update]);

  function retry() {
    startTransition(async () => {
      const res = await gqlAction<{ retryServerAgentUpdate: AgentUpdateDTO }>(
        /* GraphQL */ `mutation RetryServerAgentUpdate($id: String!) { retryServerAgentUpdate(id: $id) { ${FIELDS} } }`,
        { id: serverId },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setLive({ from: update, value: res.data!.retryServerAgentUpdate });
    });
  }

  const text = agentUpdateText(
    current,
    usable,
    Date.now(),
    agentLinks(version),
  );
  if (!text) return null;
  const line = (
    <span
      className={
        usable ? "text-sm text-muted-foreground" : "text-sm text-destructive"
      }
    >
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {current?.lastError ? (
        <SimpleTooltip content={current.lastError}>{line}</SimpleTooltip>
      ) : (
        line
      )}
      {current?.failed && (
        <Button
          variant="outline"
          size="sm"
          onClick={retry}
          disabled={pending || current.running}
        >
          <RotateCw
            className={current.running ? "size-4 animate-spin" : "size-4"}
          />
          Retry now
        </Button>
      )}
    </div>
  );
}
