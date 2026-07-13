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
  Gauge,
  ListChecks,
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";
import {
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";
import { ServerReadinessDialog } from "./server-readiness-dialog";

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
 *   - Remove server — revoke the agent's trust and forget the row. It does NOT
 *     uninstall anything on the host (Deplo has no RPC that could, and revoking
 *     trust is exactly what ends its right to command that agent), so the
 *     mutation hands back the host-side uninstall command and we show it the
 *     moment the server is gone. The list refresh is deferred until that dialog
 *     is dismissed — refreshing immediately would unmount this component, taking
 *     the command with it.
 */

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
  deployConcurrency,
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
  /** How many deployments this server runs at once (the deploy-queue slot count). */
  deployConcurrency: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [command, setCommand] = React.useState<string | null>(null);
  /** Set once the server is removed: the host-side uninstall one-liner to run. */
  const [uninstall, setUninstall] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [confirmUpdate, setConfirmUpdate] = React.useState(false);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: accessAllTeams,
    teamIds: accessTeamIds,
  });
  const [concurrencyOpen, setConcurrencyOpen] = React.useState(false);
  const [concurrency, setConcurrency] = React.useState(String(deployConcurrency));
  // The readiness dialog owns its own probe + loading state (it writes nothing and
  // refreshes nothing), so it deliberately stays out of the shared `pending` flow.
  const [readinessOpen, setReadinessOpen] = React.useState(false);

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
        // Surfaces the "these teams still have apps/databases…" block message.
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

  function openConcurrency() {
    setConcurrency(String(deployConcurrency));
    setConcurrencyOpen(true);
  }

  function saveConcurrency() {
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      toast.error("Enter a whole number between 1 and 50");
      return;
    }
    startTransition(async () => {
      const res = await gqlAction<{ setServerDeployConcurrency: { id: string } }>(
        `mutation SetServerDeployConcurrency($id: String!, $concurrency: Int!) {
          setServerDeployConcurrency(id: $id, concurrency: $concurrency) { id }
        }`,
        { id: serverId, concurrency: n },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConcurrencyOpen(false);
      toast.success(
        n === 1
          ? `${serverName} runs one deploy at a time`
          : `${serverName} runs up to ${n} deploys at once`,
      );
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await gqlAction<{
        removeServer: { uninstallCommand: string; warning: string | null };
      }>(
        `mutation RemoveServer($id: String!) {
          removeServer(id: $id) {
            uninstallCommand
            warning
          }
        }`,
        { id: serverId },
      );
      if (!res.ok) {
        // Surfaces the "move or delete the apps/databases on this server first"
        // block verbatim.
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      setConfirmRemove(false);
      const { uninstallCommand, warning } = res.data.removeServer;
      toast.success(`${serverName} removed — now clean up the host`);
      // A stranded-volume hazard (an App was mid-move off this host) rides in its
      // own toast, verbatim, so it is not lost behind the cleanup dialog.
      if (warning) toast.warning(warning);
      // NOT router.refresh() here — that would drop this server's card and unmount
      // us mid-dialog. The refresh runs when the operator dismisses the command.
      setUninstall(uninstallCommand);
    });
  }

  /** The server is already gone from the DB; catch the list up now. */
  function closeCleanup() {
    setUninstall(null);
    router.refresh();
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
        <DropdownMenuContent align="end" className="w-56">
          {outdated ? (
            <>
              <SimpleTooltip
                content="Update the agent binary in place to the latest release"
                side="left"
              >
                <DropdownMenuItem
                  onSelect={(e: Event) => {
                    e.preventDefault();
                    setConfirmUpdate(true);
                  }}
                  disabled={pending}
                >
                  <CircleFadingArrowUp className="size-4" />
                  Update agent to v{expectedVersion}
                </DropdownMenuItem>
              </SimpleTooltip>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <SimpleTooltip
            content="Check that this server is set up and ready to run deployments"
            side="left"
          >
            <DropdownMenuItem
              onSelect={(e: Event) => {
                e.preventDefault();
                setReadinessOpen(true);
              }}
              disabled={pending}
            >
              <ListChecks className="size-4" />
              Check readiness
            </DropdownMenuItem>
          </SimpleTooltip>
          <SimpleTooltip
            content="Mint a fresh one-time bootstrap/install command for this server"
            side="left"
          >
            <DropdownMenuItem onSelect={() => reissue()} disabled={pending}>
              <KeyRound className="size-4" />
              {provisioning ? "Show install command" : "Reissue install command"}
            </DropdownMenuItem>
          </SimpleTooltip>
          {canManageInfra ? (
            <SimpleTooltip
              content="Choose which teams can deploy to this server"
              side="left"
            >
              <DropdownMenuItem
                onSelect={(e: Event) => {
                  e.preventDefault();
                  openAccess();
                }}
                disabled={pending}
              >
                <Users className="size-4" />
                Team access
              </DropdownMenuItem>
            </SimpleTooltip>
          ) : null}
          {canManageInfra ? (
            <SimpleTooltip
              content="How many deployments this server runs at once"
              side="left"
            >
              <DropdownMenuItem
                onSelect={(e: Event) => {
                  e.preventDefault();
                  openConcurrency();
                }}
                disabled={pending}
              >
                <Gauge className="size-4" />
                Build concurrency
              </DropdownMenuItem>
            </SimpleTooltip>
          ) : null}
          <DropdownMenuSeparator />
          <SimpleTooltip
            content="Revoke the agent's trust and tear down its containers"
            side="left"
          >
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e: Event) => {
                e.preventDefault();
                setConfirmRemove(true);
              }}
              disabled={pending}
            >
              <Trash2 className="size-4" />
              Remove server
            </DropdownMenuItem>
          </SimpleTooltip>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Live readiness report — dials the agent on open, persists nothing. */}
      <ServerReadinessDialog
        serverId={serverId}
        serverName={serverName}
        open={readinessOpen}
        onOpenChange={setReadinessOpen}
      />

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
              Choose which teams can deploy apps and databases to this server.
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

      {/* Edit per-server deploy concurrency (the deploy-queue slot count). */}
      <Dialog open={concurrencyOpen} onOpenChange={setConcurrencyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gauge className="size-4" />
              Build concurrency for {serverName}
            </DialogTitle>
            <DialogDescription>
              How many deployments this server runs at the same time. Extra deploys
              wait in a queue and start as slots free up; deploys on other servers
              are unaffected and run in parallel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="deploy-concurrency"
              info="1 means one deploy at a time on this server (the safe default). Two deploys of the same app never run at once regardless of this value."
            >
              Concurrent deployments
            </FieldLabel>
            <Input
              id="deploy-concurrency"
              type="number"
              min={1}
              max={50}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              disabled={pending}
              className="w-28"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConcurrencyOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => saveConcurrency()} disabled={pending}>
              {pending ? "Saving…" : "Save"}
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
              This revokes the agent&rsquo;s trust and forgets the server.{" "}
              <strong>It does not uninstall anything on the host</strong> — the
              Deplo agent, Traefik on :80/:443 and the <code>deplo</code> network
              all keep running there. We&rsquo;ll give you the command to remove
              them as soon as it&rsquo;s gone. You can&rsquo;t remove a server
              while apps or databases still live on it — move or delete those
              first.
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

      {/* The server is gone from Deplo; its agent is still running on the host.
          This is the only thing that can actually remove it. */}
      <Dialog
        open={uninstall !== null}
        onOpenChange={(open) => {
          if (!open) closeCleanup();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ServerCog className="size-4" />
              Finish the cleanup on {serverName}
            </DialogTitle>
            <DialogDescription>
              Deplo no longer trusts this server, but its agent is still installed
              and running there. Run this on the host, as root, to remove it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Uninstall command</Label>
            {uninstall ? <CommandLine command={uninstall} /> : null}
            <p className="text-muted-foreground text-xs">
              Removes the deplo-agent service and binary,{" "}
              <code>/var/lib/deplo-agent</code> (its certificates and
              Traefik&rsquo;s issued TLS certs), the <code>deplo-traefik</code>{" "}
              container, the SSH gateway and the <code>deplo</code> Docker
              network. It leaves Docker itself alone, and it does{" "}
              <strong>not</strong> delete your data — app and database volumes,
              built images and <code>/data</code> survive. Add{" "}
              <code>--purge-data</code> to delete those too; that is
              irreversible.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => closeCleanup()}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
