"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreVertical,
  KeyRound,
  Trash2,
  ServerCog,
  CircleFadingArrowUp,
  Users,
} from "lucide-react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";
import {
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";

/**
 * Per-server management actions, shown for EVERY server card (the host running
 * Deplo included — it is a bootstrapped agent like any other). All gated
 * server-side to instance admins:
 *   - Update agent — only when the server's agent is OUTDATED. Updates the agent
 *     binary in place to the latest release WITHOUT reissuing certificates: the
 *     agent self-updates over its existing pinned-mTLS channel and re-execs with
 *     the same on-disk trust, so the server stays online with the same identity.
 *     Distinct from reissue (which re-bootstraps and would reset trust).
 *   - Reissue install command — mint a FRESH one-time bootstrap command for a
 *     server still provisioning (the original token expired or was lost). This is
 *     the "server's menu" the AddServer dialog's note points at.
 *   - Remove server — revoke trust + best-effort teardown. Returns a warning when
 *     the agent was unreachable (the stack/containers on that host must be cleaned
 *     by hand); shown so the operator knows.
 */

/**
 * The menu-primitive set used to render the server's action list once and reuse
 * it for BOTH the ⋯ dropdown (left-click) and the right-click context menu —
 * same items, same handlers, no duplication. Radix dropdown and context menus
 * share an isomorphic API, so the renderer just takes whichever set applies.
 */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

export function ServerActions({
  serverId,
  serverName,
  provisioning,
  outdated,
  expectedVersion,
  canManageInfra,
  teams,
  accessAllTeams,
  accessTeamIds,
}: {
  serverId: string;
  serverName: string;
  /** Still awaiting the agent's call-home — show the reissue action prominently. */
  provisioning: boolean;
  /** The agent is strictly behind the latest release — offer the in-place update. */
  outdated: boolean;
  /** The latest agent version we'd update to, for the menu label + confirm copy. */
  expectedVersion: string;
  /** Whether the viewer may edit team access (gates the "Team access" item). */
  canManageInfra: boolean;
  /** Every team in the instance, for the access picker. */
  teams: TeamOption[];
  /** This server's current access scope. */
  accessAllTeams: boolean;
  accessTeamIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [command, setCommand] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [confirmUpdate, setConfirmUpdate] = React.useState(false);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: accessAllTeams,
    teamIds: accessTeamIds,
  });

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

  function update() {
    startTransition(async () => {
      const res = await gqlAction<{ updateServerAgent: string }>(
        `mutation UpdateServerAgent($id: String!) {
          updateServerAgent(id: $id)
        }`,
        { id: serverId },
      );
      if (!res.ok) {
        // Surfaces the server-side message verbatim, including the "this agent is
        // too old to self-update remotely — re-run the installer for now" case
        // (until the agent ships the self-update RPC).
        toast.error(res.error);
        return;
      }
      setConfirmUpdate(false);
      const version = res.data?.updateServerAgent;
      toast.success(
        version
          ? `${serverName} agent updated to v${version}`
          : `${serverName} agent updated`,
      );
      router.refresh();
    });
  }

  function openAccess() {
    // Re-seed from the latest props each open so a prior save is reflected.
    setAccess({ allTeams: accessAllTeams, teamIds: accessTeamIds });
    setAccessOpen(true);
  }

  function saveAccess() {
    startTransition(async () => {
      const res = await gqlAction<{ setServerTeams: { id: string } }>(
        `mutation SetServerTeams($input: SetServerTeamsInput!) {
          setServerTeams(input: $input) { id }
        }`,
        {
          input: {
            serverId,
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
          },
        },
      );
      if (!res.ok) {
        // Surfaces the "these teams still have projects/databases…" block message.
        toast.error(res.error);
        return;
      }
      setAccessOpen(false);
      toast.success(
        access.allTeams
          ? `${serverName} is now available to all teams`
          : `${serverName} team access updated`,
      );
      router.refresh();
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

  // The server's actions, rendered once for whichever menu primitive is passed.
  // Shared by the ⋯ dropdown (left-click) and the right-click context menu so
  // the two can never drift apart.
  const menu = (K: MenuKit) => (
    <>
      {outdated ? (
        <>
          <SimpleTooltip
            content="Update the agent binary in place to the latest release"
            side="left"
          >
            <K.Item
              onSelect={(e: Event) => {
                e.preventDefault();
                setConfirmUpdate(true);
              }}
              disabled={pending}
            >
              <CircleFadingArrowUp className="size-4" />
              Update agent to v{expectedVersion}
            </K.Item>
          </SimpleTooltip>
          <K.Separator />
        </>
      ) : null}
      <SimpleTooltip
        content="Mint a fresh one-time bootstrap/install command for this server"
        side="left"
      >
        <K.Item onSelect={() => reissue()} disabled={pending}>
          <KeyRound className="size-4" />
          {provisioning ? "Show install command" : "Reissue install command"}
        </K.Item>
      </SimpleTooltip>
      {canManageInfra ? (
        <SimpleTooltip
          content="Choose which teams can deploy to this server"
          side="left"
        >
          <K.Item
            onSelect={(e: Event) => {
              e.preventDefault();
              openAccess();
            }}
            disabled={pending}
          >
            <Users className="size-4" />
            Team access
          </K.Item>
        </SimpleTooltip>
      ) : null}
      <K.Separator />
      <SimpleTooltip
        content="Revoke the agent's trust and tear down its containers"
        side="left"
      >
        <K.Item
          variant="destructive"
          onSelect={(e: Event) => {
            e.preventDefault();
            setConfirmRemove(true);
          }}
          disabled={pending}
        >
          <Trash2 className="size-4" />
          Remove server
        </K.Item>
      </SimpleTooltip>
    </>
  );

  return (
    <>
      {/* The ⋯ dropdown is also the right-click surface: right-clicking it opens
          the SAME actions as a context menu, and stops propagation so the global
          shell context menu doesn't also fire on top of it. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            onContextMenu={(e) => e.stopPropagation()}
          >
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
              <DropdownMenuContent align="end" className="w-56">
                {menu(DROPDOWN_KIT)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {menu(CONTEXT_KIT)}
        </ContextMenuContent>
      </ContextMenu>

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

      {/* Edit team access (all teams ↔ specific teams). */}
      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Team access for {serverName}
            </DialogTitle>
            <DialogDescription>
              Choose which teams can deploy projects and databases to this server.
              You can&rsquo;t remove a team that still has workloads here — move or
              delete those first.
            </DialogDescription>
          </DialogHeader>
          <ServerTeamAccess
            value={access}
            teams={teams}
            onChange={setAccess}
            disabled={pending}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAccessOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => saveAccess()} disabled={pending}>
              {pending ? "Saving…" : "Save access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm in-place agent update (no cert reissue). */}
      <Dialog open={confirmUpdate} onOpenChange={setConfirmUpdate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleFadingArrowUp className="size-4" />
              Update agent on {serverName}?
            </DialogTitle>
            <DialogDescription>
              Updates the agent binary in place to{" "}
              <strong>v{expectedVersion}</strong> over its existing secure
              connection. Its certificates are <strong>not</strong> reissued — the
              agent restarts with the same identity, so the server stays online and
              keeps its trust. The update takes a few seconds while the agent swaps
              its binary and reconnects.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmUpdate(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => update()} disabled={pending}>
              {pending ? "Updating…" : `Update to v${expectedVersion}`}
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
