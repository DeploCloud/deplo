"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { EyeOff, MoreHorizontal, Trash2 } from "lucide-react";
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
 * What a migration source can have done to it.
 *
 * It has no management page - it is not a server anyone operates, it is another
 * platform's machine Deplo is reading volumes from - so this menu is the whole
 * surface.
 *
 * It held ONE item for a while, on the reasoning that a second ("remove without
 * uninstalling") would be a choice nobody has the information to make, and that
 * the one item degrades: with an agent it uninstalls and then forgets the host,
 * without one it just forgets it. That is true right up until the host cannot be
 * DIALED, and then it does not degrade, it dead-ends:
 *
 *  - uninstalling needs the agent to answer, and this row exists precisely
 *    because Deplo could not reach it;
 *  - so the operator runs the host-side command themselves, which takes the agent
 *    off - and now there is even less answering than before;
 *  - every further attempt fails the same way, and the row is immortal.
 *
 * Which made "The server stays in this list until the agent is gone" a promise
 * nothing could keep. So the second item is here after all, and the information
 * needed to choose it is the failure that is already on screen. `removeServer`
 * dials NOTHING - it revokes the pin, forgets the row, and hands back the
 * host-side command - so it is the one action that always works.
 *
 * Offered only for a host that was actually provisioned: with no agent, the first
 * item already does exactly this, and two entries doing the same thing is the
 * choice-nobody-can-make problem for real.
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

/**
 * The host-side command, and why it is being shown. One dialog for both endings:
 * "the agent is still there because we could not reach it" and "the agent is
 * still there because you told Deplo to stop tracking it". The command is the
 * same, and so is what the reader has to do with it.
 */
interface Leftover {
  title: string;
  detail: string;
  command: string;
  /** Whether the way out is still available - false once the row is gone. */
  offerForget: boolean;
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
  const [forgetOpen, setForgetOpen] = React.useState(false);
  const [leftover, setLeftover] = React.useState<Leftover | null>(null);
  const [forgetting, setForgetting] = React.useState(false);

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
      setLeftover({
        title: `${serverName} still has the agent`,
        detail: data.error ?? "The agent is still installed",
        command: data.uninstallCommand,
        offerForget: true,
      });
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

  async function forget() {
    const res = await gqlAction<
      { removeServer: { uninstallCommand: string; warning: string | null } },
      { uninstallCommand: string; warning: string | null }
    >(FORGET, { id: serverId }, (d) => d.removeServer);
    if (!res.ok) return res;
    if (res.data?.warning) toast.warning(res.data.warning);
    router.refresh();
    setForgetOpen(false);
    // The agent is still on that machine and Deplo can no longer take it off, so
    // the command is not a footnote here - it is the rest of the job.
    setLeftover({
      title: `Deplo stopped tracking ${serverName}`,
      detail:
        "Its agent is still installed on that machine, and Deplo can no longer remove it for you.",
      command: res.data!.uninstallCommand,
      offerForget: false,
    });
    return res;
  }

  /** The same action from inside the leftover dialog, which is its own context. */
  async function forgetFromDialog() {
    setForgetting(true);
    const res = await forget();
    setForgetting(false);
    if (!res.ok) toast.error(res.error);
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
          {provisioned && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setForgetOpen(true)}
            >
              <EyeOff className="size-4" />
              Remove from Deplo
            </DropdownMenuItem>
          )}
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

      <ConfirmAction
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        title={`Stop tracking ${serverName}?`}
        description="Deplo forgets this machine and revokes its agent's access here. The agent stays installed on the host until you run the command Deplo gives you next. Use this when the machine cannot be reached and the row will not go away on its own."
        confirmLabel="Remove from Deplo"
        successMessage={`Deplo stopped tracking ${serverName}`}
        onConfirm={forget}
      />

      {/* The agent is still on that host. The honest end of this path is the
          host-side command - the same one an unreachable or already-de-trusted
          server has always needed - plus, while the row is still here, the way to
          get rid of it. */}
      <Dialog open={leftover !== null} onOpenChange={() => setLeftover(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{leftover?.title}</DialogTitle>
            <DialogDescription>{leftover?.detail}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {leftover ? <CommandLine command={leftover.command} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Run it on the host, as root.
            </p>
          </div>
          <DialogFooter>
            {leftover?.offerForget && (
              <Button
                variant="outline"
                disabled={forgetting}
                onClick={() => void forgetFromDialog()}
              >
                Remove from Deplo
              </Button>
            )}
            <Button onClick={() => setLeftover(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
