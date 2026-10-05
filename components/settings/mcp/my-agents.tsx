"use client";

import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import { timeAgo } from "@/lib/utils";
import type { MyMcpAgentDTO } from "@/lib/data/mcp-clients";
import { AGENTS } from "./agents";
import { AgentMark } from "./connect-wizard/agent-picker";
import { RobotMark } from "./robot-graphic";

const OTHER = AGENTS.find((a) => a.id === "other")!;

export function MyAgents({ agents }: { agents: MyMcpAgentDTO[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState<MyMcpAgentDTO | null>(null);
  const { visible, remove, restore } = useOptimisticRemove(agents, (a) => a.id);
  const count = visible.length;

  return (
    <>
      {count === 0 ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <RobotMark />
          No agents connected
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <RobotMark />
          {count} {count === 1 ? "agent" : "agents"} connected
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Your connected agents</DialogTitle>
            <DialogDescription>
              Only you see these. <strong>Remove</strong> cuts an agent off at
              once.
            </DialogDescription>
          </DialogHeader>
          {count === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agents connected.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {visible.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onRemove={() => setRemoving(a)}
                />
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={removing !== null}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this agent"}?`}
        description={
          <>
            <strong>{removing?.name}</strong> is disconnected and its token
            deleted.
          </>
        }
        consequence="It stops working at once, in every team it reached. This can't be undone."
        confirmLabel="Remove"
        successMessage="Agent removed"
        optimistic
        onConfirm={async () => {
          const id = removing!.id;
          remove(id);
          const res = await gqlAction(
            /* GraphQL */ `
              mutation RemoveMcpAgent($id: String!) {
                revokeToken(id: $id)
              }
            `,
            { id },
          );
          if (!res.ok) restore(id);
          router.refresh();
          return res;
        }}
      />
    </>
  );
}

function AgentRow({
  agent,
  onRemove,
}: {
  agent: MyMcpAgentDTO;
  onRemove: () => void;
}) {
  const def =
    AGENTS.find((d) => d.id === agent.agent) ??
    AGENTS.find((d) => d.label === agent.name) ??
    OTHER;
  return (
    <li className="flex items-center gap-3 p-3">
      <AgentMark agent={def} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{agent.name}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {agent.lastUsedAt
            ? `Last used ${timeAgo(agent.lastUsedAt)}`
            : "Not used yet"}
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href={`/settings/tokens/${agent.id}`}>
          <Pencil className="size-3.5" />
          Edit
        </Link>
      </Button>
      <SimpleTooltip content="Remove">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${agent.name}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </SimpleTooltip>
    </li>
  );
}
