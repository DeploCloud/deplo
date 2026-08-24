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
 * The ONE action a migration source has.
 *
 * It has no management page - it is not a server anyone operates, it is another
 * platform's machine Deplo is reading volumes from - so this menu is the whole
 * surface, and it holds exactly one item. A second entry ("remove without
 * uninstalling") would be a choice nobody has the information to make; instead the
 * one item degrades: with an agent it uninstalls and then forgets the host, and
 * without one (an install command that was never run) it just forgets it.
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

interface Result {
  removed: boolean;
  uninstallCommand: string;
  error: string | null;
  warning: string | null;
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
  const [failed, setFailed] = React.useState<Result | null>(null);

  async function uninstall() {
    const res = await gqlAction<{ uninstallServerAgent: Result }, Result>(
      UNINSTALL,
      { id: serverId },
      (d) => d.uninstallServerAgent,
    );
    if (!res.ok) return res;
    const data = res.data!;
    // A refusal comes back as a successful mutation carrying `removed: false` -
    // the host still has the agent, so say so and hand over the command rather
    // than reporting a clean removal.
    if (!data.removed) {
      // Close the confirm dialog first: this is a controlled one, and it only
      // closes itself on success - leaving it open would stack the two.
      setOpen(false);
      setFailed(data);
      return {
        ok: false as const,
        error: data.error ?? "The agent is still installed",
      };
    }
    if (data.warning) toast.warning(data.warning);
    // The row is gone server-side; re-run the page's reads so the card goes with
    // it (ConfirmAction only toasts - it does not refresh).
    router.refresh();
    return res;
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
            Uninstall agent
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title={`Uninstall the agent from ${serverName}?`}
        description={
          provisioned
            ? "Deplo removes its agent from that host and stops tracking the machine. Any data still there can no longer be copied, so finish the import first."
            : "Nothing was installed on this host yet - this only removes it from Deplo."
        }
        confirmLabel="Uninstall agent"
        successMessage={`Deplo removed itself from ${serverName}`}
        onConfirm={uninstall}
      />

      {/* The agent is still on that host, so the row is still here. The honest
          end of this path is the host-side command - the same one an unreachable
          or already-de-trusted server has always needed. */}
      <Dialog open={failed !== null} onOpenChange={() => setFailed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{serverName} still has the agent</DialogTitle>
            <DialogDescription>{failed?.error}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {failed ? <CommandLine command={failed.uninstallCommand} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Run it on the host, as root. The server stays in this list until
              the agent is gone.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setFailed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
