"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, Plus, ServerCog } from "lucide-react";
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
import { AnimatedHeight } from "@/components/shared/animated-height";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { CommandLine } from "@/components/shared/code-block";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import {
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";
import { ServerRoleOptions } from "./server-role-options";

/**
 * Register a remote server. No SSH-in: the operator names the host and gets a
 * ONE-TIME install command to paste on the box, and the agent calls home. The
 * command is shown once, hence two steps with the dialog staying open.
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
        `${name || host} registered - run the install command on it`,
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
            Connect a server
          </DialogTitle>
          <DialogDescription>
            {command
              ? "Run this once on the server. The agent installs itself and calls home."
              : "Name the host, then run the install command on it. Deplo never SSHes in."}
          </DialogDescription>
        </DialogHeader>

        {/* gap-6, not the body's gap-4: the footer used to inherit its air from
            whatever the last field rendered, so picking "Everything" glued Cancel
            to the options. */}
        <form className="grid gap-6" onSubmit={onSubmit}>
          <AnimatedHeight className="grid gap-4" scroll={false}>
            {command ? (
              <div className="space-y-2">
                <Label>Install command (shown once)</Label>
                <CommandLine command={command} />
                <p className="text-xs text-muted-foreground">
                  The command embeds a single-use token that expires in about an
                  hour. It is shown only now; if you lose it, re-mint one from
                  the server&rsquo;s menu.
                </p>
                {/**
                 * Over plain http the installer AND its checksum travel on the same unauthenticated
                 * channel, so anyone on the network path between the two machines can replace what
                 * runs as root here.
                 */}
                {command.includes("http://") ? (
                  <p className="text-xs text-warning">
                    This panel is on an http address, so the installer is
                    downloaded over an unencrypted connection. Give Deplo a
                    domain with HTTPS before adding servers over an untrusted
                    network.
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
                    docs="servers.address"
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
                {/**
                 * What the box is for.
                 */}
                <div className="space-y-2">
                  <FieldLabel
                    info="Changes what the install command sets up on the host. Most servers should do everything."
                    docs="servers.role"
                  >
                    What this server is for
                  </FieldLabel>
                  <ServerRoleOptions
                    value={role}
                    onChange={setRole}
                    disabled={() => pending}
                  />
                </div>
              </div>
            )}
          </AnimatedHeight>
          {/* One footer per phase rather than a fragment inside one: a footer
              counts its own children to place them, and a fragment hides them. */}
          {command ? (
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !host.trim()}>
                <span className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1",
                      pending && "invisible",
                    )}
                  >
                    Register server
                  </span>
                  {pending && (
                    <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                  )}
                </span>
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
