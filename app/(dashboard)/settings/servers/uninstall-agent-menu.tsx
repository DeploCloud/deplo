"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The ONE action a migration source has: get rid of it.
 *
 * It has no management page - it is not a server anyone operates, it is another
 * platform's machine Deplo is reading volumes from - so this menu is the whole
 * surface, and one item is the right number. Uninstalling the agent and forgetting
 * the row were briefly two, and that was a choice nobody has the information to
 * make: both are "I am done with this machine", and which one is possible depends
 * on whether the host answers, which is not the reader's problem to solve.
 *
 * So it is one verb that always finishes:
 *
 *  1. ask the agent to uninstall itself, and forget the row - the clean ending;
 *  2. if the host does not answer, forget the row ANYWAY and hand over the
 *     host-side command.
 *
 * Step 2 exists because without it the row was immortal. Uninstalling needs the
 * agent to ANSWER, and the rows that need it most are the ones where it does not;
 * running the command by hand then makes it worse, because there is even less
 * answering than before. "Remove from Deplo" that leaves the row behind is not a
 * removal, so the confirm says both endings up front and the press delivers one
 * of them.
 *
 * What it never does is bypass a genuine blocker: both halves go through
 * `assertServerRemovable`, so a host something still depends on refuses twice and
 * the refusal is what the reader sees.
 */
const UNINSTALL = /* GraphQL */ `
  mutation UninstallServerAgent($id: String!) {
    uninstallServerAgent(id: $id) {
      removed
      uninstallCommand
      error
      warning
    }
  }
`;

/** The half that dials nothing: revoke the pin, drop the row, hand the command. */
const FORGET = /* GraphQL */ `
  mutation ForgetMigrationSource($id: String!) {
    removeServer(id: $id) {
      uninstallCommand
      warning
    }
  }
`;

interface Result {
  removed: boolean;
  uninstallCommand: string;
  error: string | null;
  warning: string | null;
}

/** The row is gone and the agent is not. What is left to do, and why. */
interface Leftover {
  /** The host's own words for why Deplo could not take the agent off. */
  detail: string;
  command: string;
}

export function UninstallAgentMenu({
  serverId,
  serverName,
  provisioned,
}: {
  serverId: string;
  serverName: string;
  /** Whether an agent ever called home from this host. */
  provisioned: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [leftover, setLeftover] = React.useState<Leftover | null>(null);

  async function remove() {
    const un = await gqlAction<{ uninstallServerAgent: Result }, Result>(
      UNINSTALL,
      { id: serverId },
      (d) => d.uninstallServerAgent,
    );
    // The clean ending: the agent took itself off and the row went with it.
    if (un.ok && un.data?.removed) {
      if (un.data.warning) toast.warning(un.data.warning);
      toast.success(`Deplo removed itself from ${serverName}`);
      router.refresh();
      return un;
    }
    // A refusal comes back as a successful mutation carrying `removed: false`
    // (the host did not answer); a thrown one is a blocker, and the forget below
    // hits the same one and reports it.
    const why = un.ok
      ? (un.data?.error ?? "The agent did not answer")
      : un.error;
    const rm = await gqlAction<
      { removeServer: { uninstallCommand: string; warning: string | null } },
      { uninstallCommand: string; warning: string | null }
    >(FORGET, { id: serverId }, (d) => d.removeServer);
    if (!rm.ok) return rm;
    if (rm.data?.warning) toast.warning(rm.data.warning);
    toast.success(`Deplo stopped tracking ${serverName}`);
    router.refresh();
    setLeftover({ detail: why, command: rm.data!.uninstallCommand });
    return rm;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={`Actions for ${serverName}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setOpen(true)}
          >
            <Trash2 className="size-4" />
            Remove from Deplo
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Both endings are named BEFORE the press. The second one leaves an agent
          running on somebody's machine, which is not a thing to discover after
          the fact. */}
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title={`Remove ${serverName} from Deplo?`}
        description={
          provisioned
            ? "Deplo uninstalls its agent from that host and stops tracking the machine. If it cannot reach the host, it stops tracking it anyway and gives you the command to run there yourself. Any data still there can no longer be copied, so finish the import first."
            : "Nothing was installed on this host yet - this only removes it from Deplo."
        }
        confirmLabel="Remove from Deplo"
        onConfirm={remove}
      />

      {/* The row is gone; the agent is not. The command is the rest of the job,
          and it is the only thing that can take the agent off a host Deplo could
          not reach. */}
      <Dialog open={leftover !== null} onOpenChange={() => setLeftover(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{serverName} still has the agent</DialogTitle>
            <DialogDescription>{leftover?.detail}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {leftover ? <CommandLine command={leftover.command} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Deplo has stopped tracking this machine and can no longer remove
              the agent for you. Run this on the host, as root.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setLeftover(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
