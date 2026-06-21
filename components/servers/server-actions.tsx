"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreVertical, KeyRound, Trash2, ServerCog } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Per-server management actions for a REMOTE server card (PLAN Part B follow-up).
 * Two actions, both gated server-side by `manage_infra`:
 *   - Reissue install command — mint a FRESH one-time bootstrap command for a
 *     server still provisioning (the original token expired or was lost). This is
 *     the "server's menu" the AddServer dialog's note points at.
 *   - Remove server — revoke trust + best-effort teardown. Returns a warning when
 *     the agent was unreachable (the stack/containers on that host must be cleaned
 *     by hand); shown so the operator knows.
 * The master (localhost) server has no actions (it isn't provisioned this way and
 * can't be removed), so the page only renders this for `type === "remote"`.
 */
export function ServerActions({
  serverId,
  serverName,
  provisioning,
}: {
  serverId: string;
  serverName: string;
  /** Still awaiting the agent's call-home — show the reissue action prominently. */
  provisioning: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [command, setCommand] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  function reissue() {
    startTransition(async () => {
      const res = await gqlAction<{
        reissueServerBootstrap: { installCommand: string };
      }>(
        `mutation ReissueServerBootstrap($id: String!) {
          reissueServerBootstrap(id: $id) {
            installCommand
          }
        }`,
        { id: serverId },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      setCommand(res.data.reissueServerBootstrap.installCommand);
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await gqlAction<{ removeServer: string | null }>(
        `mutation RemoveServer($id: String!) {
          removeServer(id: $id)
        }`,
        { id: serverId },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirmRemove(false);
      // removeServer returns a warning string when the agent was unreachable (its
      // leftover containers need manual cleanup), else null for a clean teardown.
      const warning = res.data?.removeServer;
      if (warning) {
        toast.warning(warning);
      } else {
        toast.success(`${serverName} removed`);
      }
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Server actions"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => reissue()} disabled={pending}>
            <KeyRound className="size-4" />
            {provisioning ? "Show install command" : "Reissue install command"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={(e) => {
              e.preventDefault();
              setConfirmRemove(true);
            }}
            disabled={pending}
          >
            <Trash2 className="size-4" />
            Remove server
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Reissued install command (shown once; embeds a fresh single-use token). */}
      <Dialog
        open={command !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCommand(null);
            router.refresh();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ServerCog className="size-4" />
              Install command for {serverName}
            </DialogTitle>
            <DialogDescription>
              Run this once on the server. It installs Docker (if needed) and the
              Deplo agent, which then calls home to finish provisioning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Install command (shown once)</Label>
            {command ? <CommandLine command={command} /> : null}
            <p className="text-muted-foreground text-xs">
              The command embeds a single-use token that expires in about an hour.
              It is shown only now; if you lose it, reissue another from this menu.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setCommand(null);
                router.refresh();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm destructive removal. */}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {serverName}?</DialogTitle>
            <DialogDescription>
              This revokes the agent&rsquo;s trust and tells it to tear down its
              containers. You can&rsquo;t remove a server while projects are still
              assigned to it — reassign or delete them first. If the agent is
              unreachable, removal proceeds anyway and you&rsquo;ll need to clean
              up leftover containers on the host by hand.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRemove(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove()}
              disabled={pending}
            >
              {pending ? "Removing…" : "Remove server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
