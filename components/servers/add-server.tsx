"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Hammer, Plus, ServerCog } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { CommandLine } from "@/components/shared/code-block";
import { BetaChip } from "@/components/shared/beta-chip";
import { AGENT_PORT_NOTICE } from "@/components/shared/agent-reachability";
import { gqlAction } from "@/lib/graphql-client";
import {
  AccessOption,
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";

/**
 * Register a remote server (PLAN Part B, P1). No SSH-in: the operator names the
 * host, submits, and gets back a ONE-TIME install command to paste on the box.
 * The agent then calls home and provisions itself. The command embeds a
 * single-use token and is shown only once, so this is a two-step dialog:
 * register → reveal command (the dialog stays open on the command screen).
 */
export function AddServer({
  autoOpen = false,
  teams = [],
}: {
  autoOpen?: boolean;
  /** Every team in the instance, for the access picker (empty if not allowed). */
  teams?: TeamOption[];
} = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: true,
    teamIds: [],
  });
  const [command, setCommand] = React.useState<string | null>(null);
  // What the box is FOR. "everything" is the default and what almost every server
  // is; the other two change what the install command does on the host, which is
  // why this is decided here and not editable freely afterwards.
  const [role, setRole] = React.useState<"everything" | "build" | "storage">(
    "everything",
  );

  // Opened via the global "New ▸ Add server" menu (?new=1) → drop the param so a
  // refresh/Back doesn't reopen it.
  React.useEffect(() => {
    if (autoOpen) router.replace("/settings/servers", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setName("");
    setHost("");
    setAccess({ allTeams: true, teamIds: [] });
    setRole("everything");
    setCommand(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Step two only reveals the install command (its footer button just closes),
    // so Enter must not register the server a second time.
    if (command) return;
    submit();
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{
        addServer: { server: { id: string }; installCommand: string };
      }>(
        `mutation AddServer($input: AddServerInput!) {
          addServer(input: $input) {
            server { id }
            installCommand
          }
        }`,
        {
          input: {
            name,
            host,
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
            storageOnly: role === "storage",
            buildOnly: role === "build",
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      toast.success(
        `${name || host} registered — run the install command on it`,
      );
      setCommand(res.data.addServer.installCommand);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCog className="size-4" />
            Connect a remote server
          </DialogTitle>
          <DialogDescription>
            {command
              ? role === "storage"
                ? "Run this once on the server. It installs the Deplo agent only — no Docker, no proxy — and the agent then calls home to finish provisioning."
                : role === "build"
                  ? "Run this once on the server. It installs Docker (if needed) and the Deplo agent, but no proxy, and the agent then calls home to finish provisioning."
                  : "Run this once on the server. It installs Docker (if needed) and the Deplo agent, which then calls home to finish provisioning."
              : "Register the host, then run the install command it gives you on the box. Deplo never SSHes in — the agent connects out to this control plane."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          {command ? (
            <div className="space-y-2">
              <Label>Install command (shown once)</Label>
              <CommandLine command={command} />
              <p className="text-xs text-muted-foreground">
                The command embeds a single-use token that expires in about an
                hour. It is shown only now; if you lose it, re-mint one from the
                server&rsquo;s menu.
              </p>
              {/* Said HERE because this screen is the one moment the operator is
                  on the box. The command only proves the OUTBOUND direction works;
                  everything after it is the control plane dialing in, and the
                  server goes green either way. The Servers page probes for real on
                  load, so the check this needs already exists - what was missing
                  was telling anyone what to open. */}
              <p className="text-xs text-muted-foreground">
                {AGENT_PORT_NOTICE}
              </p>
              {/* Over plain http the installer AND its checksum travel on the same
                  unauthenticated channel, so anyone on the network path between the
                  two machines can replace what runs as root here. Nothing in the
                  command can fix that — the operator has to know. */}
              {command.includes("http://") ? (
                <p className="text-xs text-warning">
                  This panel is on an http address, so the installer is
                  downloaded over an unencrypted connection. Give Deplo a domain
                  with HTTPS before adding servers over an untrusted network.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="srv-name">Display name</Label>
                <Input
                  id="srv-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="eu-west-1"
                />
              </div>
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="srv-host"
                  info="The address this control plane will reach the agent at, and where deployed apps for this server will be routed."
                >
                  Host or IP
                </FieldLabel>
                <Input
                  id="srv-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="203.0.113.24"
                  className="font-mono text-sm"
                />
              </div>
              <ServerTeamAccess
                value={access}
                teams={teams}
                onChange={setAccess}
                disabled={pending}
              />
              {/* What the box is for. A choice rather than two checkboxes: the
                  three are mutually exclusive, and each one changes what the
                  installer does on the host. Only the build axis can be revised
                  afterwards - the backups option skips installing Docker, which
                  no later setting can undo. */}
              <div className="space-y-2">
                <FieldLabel info="Changes what the install command sets up on the host. Most servers should do everything.">
                  What this server is for
                </FieldLabel>
                <div className="grid gap-2 sm:grid-cols-3">
                  <AccessOption
                    icon={ServerCog}
                    title="Everything"
                    description="Runs apps and builds them"
                    selected={role === "everything"}
                    disabled={pending}
                    onSelect={() => setRole("everything")}
                  />
                  <AccessOption
                    icon={Hammer}
                    title="Only build"
                    description="Builds for other servers"
                    selected={role === "build"}
                    disabled={pending}
                    onSelect={() => setRole("build")}
                    badge={<BetaChip />}
                  />
                  <AccessOption
                    icon={Archive}
                    title="Only backups"
                    description="Holds backup files"
                    selected={role === "storage"}
                    disabled={pending}
                    onSelect={() => setRole("storage")}
                  />
                </div>
                {role !== "everything" && (
                  <p className="text-xs text-muted-foreground">
                    {role === "build"
                      ? "Skips the proxy. Nothing is deployed here, and it stays out of the deploy target list - apps on your other servers can build on it instead."
                      : "Skips Docker and the proxy. Nothing is deployed here, and it stays out of the deploy target list."}
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            {command ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !host.trim()}>
                  {pending ? "Registering…" : "Register server"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
